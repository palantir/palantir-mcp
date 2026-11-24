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

export const PRIVATE_PACKAGE = '@palantir/mcp'
/** First `@palantir/mcp` release that can consume the shared OAuth credential store. */
export const MINIMUM_OAUTH_PACKAGE_VERSION = '0.577.0'
/** Bounds the registry metadata request. The running MCP server is never timed out. */
export const STAGE_TIMEOUTS = { metadataMs: 30_000 }

export class OAuthStartupError extends Error {}

/**
 * npx command line that never needs a shell, so argv and the registry-scoped token reach npm
 * unchanged. Windows has only `npx.cmd`, which Node runs through cmd.exe, so run npm's bundled
 * `npx-cli.js` with this Node instead.
 */
export function npxCommand(args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return ['npx', args]
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (!existsSync(cli))
    throw new OAuthStartupError('Could not find the npm installation bundled with Node.js')
  return [process.execPath, [cli, ...args]]
}

/** Child environment for OAuth mode: no legacy FOUNDRY_TOKEN, registry-scoped npm token only. */
export function oauthChildEnvironment(
  base: NodeJS.ProcessEnv,
  npmRegistry: URL,
  accessToken: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.FOUNDRY_TOKEN
  for (const key of Object.keys(env)) {
    if (/^npm_config_\/\/.*:_authToken$/i.test(key)) delete env[key]
  }
  env.NPM_CONFIG_REGISTRY = npmRegistry.toString()
  env[`NPM_CONFIG_//${npmRegistry.host + npmRegistry.pathname}:_authToken`] = accessToken
  return env
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
  if (signal.aborted) {
    void promise.catch(() => {})
    return Promise.reject(new Error('aborted'))
  }
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

function packageVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.+-]+))?/.exec(version)
  if (!match) return false
  const got = [Number(match[1]), Number(match[2]), Number(match[3])]
  const minimum = [0, 577, 0]
  for (let i = 0; i < 3; i++) {
    if (got[i] !== minimum[i]) return got[i] > minimum[i]
  }
  return match[4] === undefined
}

async function registryGet(
  url: URL,
  token: string,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  return request(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal,
  })
}

/**
 * Resolve the exact private version before it is started. One 401 renews and retries once;
 * 403 never renews. Versions below 0.577.0 are refused with no legacy fallback.
 */
export async function resolvePrivatePackage(
  npmRegistry: URL,
  client: OAuthClient,
  credential: Credential,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  timeoutMs = STAGE_TIMEOUTS.metadataMs,
): Promise<{ version: string; credential: Credential }> {
  const url = new URL(npmRegistry.toString())
  url.pathname += encodeURIComponent(PRIVATE_PACKAGE)
  if (signal.aborted) throw cancelled()
  const stage = stageSignal(signal, timeoutMs)
  try {
    let current = credential
    let response: Response
    const load = (token: string) =>
      untilAborted(registryGet(url, token, request, stage.signal), stage.signal)
    try {
      response = await load(current.accessToken)
      if (response.status === 401) {
        discardBody(response)
        current = await untilAborted(
          client.acquire({ rejectedAccessToken: current.accessToken, signal: stage.signal }),
          stage.signal,
        )
        response = await load(current.accessToken)
      }
    } catch (error) {
      if (signal.aborted) throw cancelled()
      if (error instanceof OAuthStartupError) throw error
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
    if (!packageVersionSupported(version))
      throw new OAuthStartupError(
        `@palantir/mcp ${version} does not support OAuth (requires ${MINIMUM_OAUTH_PACKAGE_VERSION} or newer). Use token authentication on this stack.`,
      )
    return { version, credential: current }
  } finally {
    stage.dispose()
  }
}

/**
 * OAuth startup: acquire credentials before any private package access, resolve an exact supported
 * version, then start it. That npx invocation downloads and runs the package. No legacy fallback.
 */
export async function runOAuthRuntime(
  config: OAuthConfig,
  forwardedArgs: string[],
  client = new OAuthClient(config),
): Promise<void> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  let child: ChildProcess
  try {
    try {
      checkNodeVersion()
    } catch (error) {
      throw new OAuthStartupError((error as Error).message)
    }
    if (controller.signal.aborted) throw cancelled()
    let credential: Credential
    try {
      credential = await client.acquire({ signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw cancelled()
      if (error instanceof OAuthStartupError) throw error
      throw new OAuthStartupError(
        'OAuth authentication failed or was cancelled. Check client installation, connectivity and callback availability; no legacy fallback was attempted.',
      )
    }
    const npmRegistry = buildNpmRegistryUrl(new URL(config.host))
    const resolved = await resolvePrivatePackage(
      npmRegistry,
      client,
      credential,
      controller.signal,
      client.request,
    )
    if (controller.signal.aborted) throw cancelled()
    const spec = `${PRIVATE_PACKAGE}@${resolved.version}`
    const env = oauthChildEnvironment(process.env, npmRegistry, resolved.credential.accessToken)
    const [command, args] = npxCommand(['-y', spec, ...privateRuntimeArgs(config, forwardedArgs)])
    child = spawnProcess(command, args, { stdio: 'inherit', shell: false, env })
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
