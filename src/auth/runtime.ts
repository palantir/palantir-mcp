/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { ChildProcess, spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { checkNodeVersion } from '../preflightChecks.js'
import { buildNpmRegistryUrl } from '../registry.js'
import { privateRuntimeArgs } from './arguments.js'
import { OAuthClient } from './client.js'
import { OAuthConfig } from './config.js'
import { discardBody } from './response.js'
import { Credential } from './store.js'
import { OAuthTokenProvider } from './tokenProvider.js'

export const PRIVATE_PACKAGE = '@palantir/mcp'
/**
 * Bounds for each startup stage the wrapper owns. The running MCP server itself is never timed out.
 * `killGraceMs` is the wait after SIGTERM before SIGKILL, and again before the stage is abandoned.
 */
export const STAGE_TIMEOUTS = {
  connectivityMs: 30_000,
  metadataMs: 30_000,
  downloadMs: 300_000,
  killGraceMs: 2_000,
}

export class OAuthStartupError extends Error {}

/** Signals the child's process group (Windows: process tree) of npm/npx and descendants, never wider. */
export type KillProcessGroup = (child: ChildProcess, signal: NodeJS.Signals) => void

export const killProcessGroup: KillProcessGroup = (child, signal) => {
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups or graceful signals for console programs:
    // terminate the child's process tree.
    if (child.pid === undefined) return
    spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).once('error', () => console.error('Could not terminate the download process tree.'))
    return
  }
  try {
    // The download stage is spawned detached, so its pid leads a dedicated process group.
    if (child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    console.error('Could not signal the download process group; attempting the direct child.')
    try {
      child.kill(signal)
    } catch (childError) {
      if ((childError as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error('Could not signal the download child process.')
    }
  }
}

/**
 * npx command line that never needs a shell, so argv (for example the space-separated
 * `--oauth-scopes` value) and the registry-scoped token variable reach npm unchanged. Windows has
 * only `npx.cmd`, which Node runs through cmd.exe, so run npm's bundled `npx-cli.js` with this
 * Node instead.
 */
export function npxCommand(args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return ['npx', args]
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (!existsSync(cli))
    throw new OAuthStartupError('Could not find the npm installation bundled with Node.js')
  return [process.execPath, [cli, ...args]]
}

export interface RuntimeDependencies {
  request: typeof fetch
  spawn: typeof spawnProcess
  client: OAuthClient
  log: (message: string) => void
  timeouts: Partial<typeof STAGE_TIMEOUTS> & Omit<typeof STAGE_TIMEOUTS, 'killGraceMs'>
  killProcessGroup?: KillProcessGroup
}

/** Child environment for OAuth mode: no legacy FOUNDRY_TOKEN, registry-scoped npm token only. */
export function oauthChildEnvironment(
  base: NodeJS.ProcessEnv,
  npmRegistry: URL,
  accessToken: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  // An inherited legacy token is ignored; the private runtime must select OAuth explicitly.
  delete env.FOUNDRY_TOKEN
  for (const key of Object.keys(env)) {
    if (/^npm_config_\/\/.*:_authToken$/i.test(key)) delete env[key]
  }
  env.NPM_CONFIG_REGISTRY = npmRegistry.toString()
  // Registry transport only. The private runtime reads its own credential state from the store.
  env[`NPM_CONFIG_//${npmRegistry.host + npmRegistry.pathname}:_authToken`] = accessToken
  return env
}

export function describeGrant(config: OAuthConfig, credential: Credential): string {
  const requested = config.scopes.filter((scope) => scope !== 'offline_access')
  if (credential.grantedScopes === null)
    return 'OAuth grant: the token endpoint did not report scopes; the server enforces effective permissions.'
  const omitted = requested.filter((scope) => !credential.grantedScopes!.includes(scope))
  const granted = credential.grantedScopes.length ? credential.grantedScopes.join(' ') : '(none)'
  return omitted.length
    ? `OAuth grant: ${granted}. Requested but not granted: ${omitted.join(' ')}; Foundry enforces operation permissions.`
    : `OAuth grant: ${granted}.`
}

function stageSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  parent.addEventListener('abort', abort, { once: true })
  if (parent.aborted) abort()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

const cancelled = () => new OAuthStartupError('OAuth startup was cancelled')

/** Settle with `promise`, or reject as soon as `signal` aborts even if `promise` never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The abandoned operation can still reject after cancellation; its result is no longer used.
  if (signal.aborted) void promise.catch(() => {})
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/**
 * Resolve the exact private version. The deadline includes response body parsing and the single
 * 401 renewal; 403 never renews. Scopes are reported, never used to gate startup or tools.
 */
export async function resolvePrivatePackage(
  npmRegistry: URL,
  credential: Credential,
  deps: RuntimeDependencies,
  signal: AbortSignal,
  checkCredential: (credential: Credential) => void = () => {},
): Promise<{ version: string; credential: Credential }> {
  const url = new URL(npmRegistry.toString())
  url.pathname += encodeURIComponent(PRIVATE_PACKAGE)
  if (signal.aborted) throw cancelled()
  const stage = stageSignal(signal, deps.timeouts.metadataMs)
  const provider = new OAuthTokenProvider(deps.client, deps.request, credential)
  try {
    let response: Response
    try {
      response = await untilAborted(
        provider.fetch(url, {
          headers: { Accept: 'application/json' },
          signal: stage.signal,
        }),
        stage.signal,
      )
    } catch {
      if (signal.aborted) throw cancelled()
      throw new OAuthStartupError(
        'Private package metadata request or credential renewal failed, timed out or was cancelled',
      )
    }
    if (!response.ok) {
      discardBody(response)
      if (response.status === 401)
        throw new OAuthStartupError('The registry rejected the refreshed OAuth access token')
      if (response.status === 403)
        throw new OAuthStartupError(
          'The OAuth grant does not permit access to the private MCP package. Ask an administrator to allow the required operations for this client.',
        )
      throw new OAuthStartupError(
        `Private package metadata responded with unexpected status ${response.status}`,
      )
    }
    const current = provider.credential!
    if (current !== credential) checkCredential(current)
    let version: unknown
    try {
      const metadata = (await untilAborted(response.json(), stage.signal)) as {
        'dist-tags'?: { latest?: unknown }
      }
      version = metadata?.['dist-tags']?.latest
    } catch {
      discardBody(response)
      if (stage.signal.aborted)
        throw new OAuthStartupError('Private package metadata timed out or was cancelled')
      throw new OAuthStartupError('Private package metadata was not valid JSON')
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version))
      throw new OAuthStartupError('Private package metadata has no valid latest version')
    return { version, credential: current }
  } finally {
    stage.dispose()
  }
}

/**
 * Bounded download stage: install the exact version into the npx cache without serving stdio.
 * The child leads its own process group (Windows: process tree) so timeout/cancellation reaches npm descendants only.
 * Termination escalates SIGTERM -> SIGKILL and the stage settles even if no exit is observed.
 */
export async function prefetchPrivatePackage(
  spec: string,
  env: NodeJS.ProcessEnv,
  deps: RuntimeDependencies,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw cancelled()
  const graceMs = deps.timeouts.killGraceMs ?? STAGE_TIMEOUTS.killGraceMs
  const killGroup = deps.killProcessGroup ?? killProcessGroup
  const stage = stageSignal(signal, deps.timeouts.downloadMs)
  let child: ChildProcess
  try {
    const [command, args] = npxCommand(['-y', '--package', spec, '--', 'node', '--version'])
    child = deps.spawn(command, args, {
      // stdout is the MCP protocol channel of the parent; keep it clean.
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
      // A dedicated POSIX process group; Windows terminates the process tree instead, and a
      // detached child there would get its own console.
      detached: process.platform !== 'win32',
      windowsHide: true,
      env,
    })
  } catch (error) {
    stage.dispose()
    if (error instanceof OAuthStartupError) throw error
    throw new OAuthStartupError('Could not start npx to download the private package')
  }
  const timers: NodeJS.Timeout[] = []
  let terminate = () => {}
  try {
    const outcome = await new Promise<'exit' | 'error' | 'abandoned'>((resolve) => {
      let exitCode: number | null = null
      child.once('error', () => resolve('error'))
      child.once('exit', (code) => {
        exitCode = code
        resolve(code === 0 ? 'exit' : 'error')
      })
      terminate = () => {
        if (exitCode !== null) return
        killGroup(child, 'SIGTERM')
        timers.push(
          setTimeout(() => {
            killGroup(child, 'SIGKILL')
            timers.push(setTimeout(() => resolve('abandoned'), graceMs))
          }, graceMs),
        )
      }
      stage.signal.addEventListener('abort', terminate, { once: true })
      // Race-safe: an abort that landed before the listener was attached still terminates.
      if (stage.signal.aborted) terminate()
    })
    if (stage.signal.aborted) {
      // Make sure nothing in the group survives a timeout, even after the direct child exited.
      killGroup(child, 'SIGKILL')
      if (signal.aborted) throw cancelled()
      throw new OAuthStartupError(
        outcome === 'abandoned'
          ? 'Private package download timed out and did not exit after SIGKILL'
          : 'Private package download timed out',
      )
    }
    if (outcome !== 'exit') throw new OAuthStartupError('Private package download failed')
  } finally {
    for (const timer of timers) clearTimeout(timer)
    stage.signal.removeEventListener('abort', terminate)
    stage.dispose()
  }
}

/**
 * OAuth startup: authenticate before any private package access, report grants, resolve and
 * download the exact private version with the OAuth access token, then start it with the v1
 * handoff argv and inherited stdio. No legacy cache, Git token, browser broker or FOUNDRY_TOKEN.
 */
export async function startOAuthRuntime(
  config: OAuthConfig,
  forwardedArgs: string[],
  deps: RuntimeDependencies,
  signal: AbortSignal,
): Promise<ChildProcess> {
  try {
    checkNodeVersion()
  } catch (error) {
    throw new OAuthStartupError((error as Error).message)
  }
  const foundryApiUrl = new URL(config.host)
  const npmRegistry = buildNpmRegistryUrl(foundryApiUrl)
  if (signal.aborted) throw cancelled()
  const connectivity = stageSignal(signal, deps.timeouts.connectivityMs)
  try {
    // Unauthenticated reachability check, matching legacy preflight; never sends credentials.
    const response = await untilAborted(
      deps.request(foundryApiUrl, { signal: connectivity.signal }),
      connectivity.signal,
    )
    discardBody(response)
    if (!response.ok) throw new Error('Unexpected status')
  } catch {
    if (signal.aborted) throw cancelled()
    throw new OAuthStartupError(`Could not reach ${config.host}`)
  } finally {
    connectivity.dispose()
  }
  if (signal.aborted) throw cancelled()
  let credential: Credential
  try {
    const provider = new OAuthTokenProvider(
      deps.client,
      deps.request,
      undefined,
      deps.timeouts.downloadMs + 60_000,
    )
    await provider.getToken(signal)
    credential = provider.credential!
  } catch {
    if (signal.aborted) throw cancelled()
    throw new OAuthStartupError(
      'OAuth authentication failed or was cancelled. Check client installation, connectivity and callback availability; no legacy fallback was attempted.',
    )
  }
  deps.log(describeGrant(config, credential))
  const resolved = await resolvePrivatePackage(npmRegistry, credential, deps, signal, (current) => {
    deps.log(`OAuth credential refreshed after registry 401. ${describeGrant(config, current)}`)
  })
  const spec = `${PRIVATE_PACKAGE}@${resolved.version}`
  const env = oauthChildEnvironment(process.env, npmRegistry, resolved.credential.accessToken)
  await prefetchPrivatePackage(spec, env, deps, signal)
  if (signal.aborted) throw new OAuthStartupError('OAuth startup was cancelled')
  const [command, args] = npxCommand([
    '-y',
    '--prefer-offline',
    spec,
    ...privateRuntimeArgs(config, forwardedArgs),
  ])
  return deps.spawn(command, args, { stdio: 'inherit', shell: false, env })
}

/** Entry point used by index.ts. Never falls back to legacy authentication. */
export async function runOAuthRuntime(
  config: OAuthConfig,
  forwardedArgs: string[],
  overrides: Partial<RuntimeDependencies> = {},
): Promise<void> {
  const deps: RuntimeDependencies = {
    request: fetch,
    spawn: spawnProcess,
    client: new OAuthClient(config),
    log: (message) => console.error(message),
    timeouts: STAGE_TIMEOUTS,
    ...overrides,
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  // Persistent during startup: a repeated signal must not hit Node's default exit while the
  // detached download group is being terminated.
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  let child: ChildProcess
  try {
    child = await startOAuthRuntime(config, forwardedArgs, deps, controller.signal)
  } catch (error) {
    console.error(
      error instanceof OAuthStartupError ? error.message : 'OAuth startup failed unexpectedly',
    )
    process.exitCode = 1
    return
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  child.once('error', () => {
    console.error('Could not start the private MCP package')
    process.exitCode = 1
  })
  child.once('exit', (code, signalName) => {
    process.exitCode = code ?? (signalName ? 1 : 0)
  })
}
