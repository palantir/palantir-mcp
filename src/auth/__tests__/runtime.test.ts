/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { ChildProcess, spawn as realSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { privateRuntimeArgs, selectRuntime } from '../arguments.js'
import { OAuthClient } from '../client.js'
import { OAuthConfig, TOOL_PERMISSION_GROUP_NAMES } from '../config.js'
import {
  killProcessGroup,
  oauthChildEnvironment,
  OAuthStartupError,
  prefetchPrivatePackage,
  resolvePrivatePackage,
  RuntimeDependencies,
  startOAuthRuntime,
} from '../runtime.js'
import { Credential, OAuthStore } from '../store.js'
import { oauthMetadata } from './fixtures/oauthMetadata.js'

const READ = 'palantir-mcp:read-metadata'
const EXECUTE = 'palantir-mcp:execute'
const oauthArgs = [
  '--auth=oauth',
  '--foundry-api-url',
  'https://example.com',
  '--oauth-client-id',
  'fixture',
  '--oauth-redirect',
  'http://127.0.0.1:49152/callback',
  '--oauth-scopes',
  `${READ} ${EXECUTE}`,
]
const select = (args: string[]) => selectRuntime(['node', 'wrapper', ...args])
const oauth = (args: string[]) => {
  const selection = select(args)
  if (selection.mode !== 'oauth') throw new Error('expected oauth')
  return selection
}

describe('--auth mode selection', () => {
  it('defaults to legacy and preserves argv byte-for-byte', () => {
    const argv = [
      'node',
      'w',
      '--foundry-api-url',
      'http://h/p',
      '--foundry-token',
      '--auth=oauth',
      '--x',
    ]
    expect(selectRuntime(argv)).toEqual({ mode: 'legacy', argv })
  })
  it.each([['--auth=legacy'], ['--auth', 'legacy']])('strips explicit %s only', (...flag) => {
    const argv = ['node', 'w', '--foundry-token=t', ...flag, '--x']
    expect(selectRuntime(argv)).toEqual({
      mode: 'legacy',
      argv: ['node', 'w', '--foundry-token=t', '--x'],
    })
  })
  it.each([
    [['--auth=other']],
    [['--auth']],
    [['--auth=legacy', '--auth=oauth']],
    [['--oauth']],
    [['--oauth-unknown=1']],
    [['--oauth-client-id', 'c']],
    [['--auth=legacy', '--oauth-profile', 'work']],
  ])('rejects %j rather than falling back', (args) => {
    expect(() => select(args)).toThrow()
  })
  it('leaves duplicate/missing legacy URLs to legacy parsing but rejects them in OAuth mode', () => {
    const argv = ['node', 'w', '--foundry-api-url', 'https://a', '--foundry-api-url', 'https://b']
    expect(selectRuntime(argv)).toEqual({ mode: 'legacy', argv })
    expect(() => select([...oauthArgs, '--foundry-api-url', 'https://example.com'])).toThrow(
      'only once',
    )
    expect(() => select(['--auth=oauth', '--foundry-api-url'])).toThrow(
      'requires --foundry-api-url',
    )
  })
  it('rejects explicit oauth with --foundry-token without echoing the value', () => {
    for (const token of [
      ['--foundry-token', 'synthetic-secret'],
      ['--foundry-token=synthetic-secret'],
    ]) {
      expect(() => select([...oauthArgs, ...token])).toThrow('conflicts with --foundry-token')
      try {
        select([...oauthArgs, ...token])
      } catch (error) {
        expect((error as Error).message).not.toContain('synthetic-secret')
      }
    }
  })
  it('requires an HTTPS origin and approved client configuration', () => {
    expect(() => select(['--auth=oauth'])).toThrow('--foundry-api-url')
    expect(() => select(['--auth=oauth', '--foundry-api-url', 'https://example.com/path'])).toThrow(
      'HTTPS origin',
    )
  })
  it('resolves dedicated MCP defaults before forwarding nonsecret configuration', () => {
    const { config, forwardedArgs } = oauth([
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
    ])
    expect(config).toMatchObject({
      clientId: 'e9036da0035845c988db3a6536f08a42',
      redirect: 'http://127.0.0.1:49152/oauth2redirect/palantir-mcp',
    })
    expect(privateRuntimeArgs(config, forwardedArgs)).toEqual([
      'start',
      'local-development',
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-client-id',
      'e9036da0035845c988db3a6536f08a42',
      '--oauth-redirect',
      'http://127.0.0.1:49152/oauth2redirect/palantir-mcp',
      '--oauth-profile',
      'default',
      '--oauth-scopes',
      ['offline_access', ...TOOL_PERMISSION_GROUP_NAMES].sort().join(' '),
    ])
  })
  it('consumes wrapper options and forwards ordinary private options', () => {
    const selection = oauth([
      '--disable-tools',
      'a,b',
      ...oauthArgs,
      '--oauth-profile=work',
      '--no-tool-search',
    ])
    expect(selection.forwardedArgs).toEqual(['--disable-tools', 'a,b', '--no-tool-search'])
    expect(selection.config).toMatchObject({
      host: 'https://example.com',
      clientId: 'fixture',
      profile: 'work',
      scopes: [EXECUTE, READ, 'offline_access'].sort(),
    })
  })
  it('builds the nonsecret v1 private handoff argv', () => {
    const { config } = oauth(oauthArgs)
    expect(privateRuntimeArgs(config, ['--x'])).toEqual([
      'start',
      'local-development',
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-client-id',
      'fixture',
      '--oauth-redirect',
      'http://127.0.0.1:49152/callback',
      '--oauth-profile',
      'default',
      '--oauth-scopes',
      `offline_access ${EXECUTE} ${READ}`,
      '--x',
    ])
  })
})

describe('OAuth child environment', () => {
  it('strips inherited legacy and npm tokens; sets registry-scoped OAuth token only', () => {
    const registry = new URL('https://example.com/artifacts/npm/')
    const env = oauthChildEnvironment(
      { FOUNDRY_TOKEN: 'legacy', 'npm_config_//other/:_authToken': 'x', PATH: '/bin' },
      registry,
      'oauth-access',
    )
    expect(env.FOUNDRY_TOKEN).toBeUndefined()
    expect(env['npm_config_//other/:_authToken']).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(env.NPM_CONFIG_REGISTRY).toBe(registry.toString())
    expect(env['NPM_CONFIG_//example.com/artifacts/npm/:_authToken']).toBe('oauth-access')
  })
})

describe('OAuth startup sequence', () => {
  let directory: string
  let config: OAuthConfig
  let store: OAuthStore
  const previous = process.env.FOUNDRY_TOKEN
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-runtime-'))
    config = oauth(oauthArgs).config
    store = new OAuthStore(config, directory)
    process.env.FOUNDRY_TOKEN = 'synthetic-inherited-legacy'
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.FOUNDRY_TOKEN
    else process.env.FOUNDRY_TOKEN = previous
    await fs.rm(directory, { recursive: true, force: true })
  })
  const seed = (extra: Partial<Credential> = {}) =>
    store.locked(() =>
      store.write({
        version: 1,
        binding: store.binding,
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        expiresAt: Date.now() + 3_600_000,
        requestedScopes: config.scopes,
        grantedScopes: [READ],
        ...extra,
      }),
    )
  const child = (code: number | null = 0, delayMs = 0) => {
    const emitter = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
    emitter.kill = vi.fn(() => {
      setImmediate(() => emitter.emit('exit', null, 'SIGTERM'))
      return true
    })
    // Exit is emitted only after the code under test spawned it and attached listeners.
    ;(emitter as EventEmitter & { start?: () => void }).start = () => {
      if (delayMs >= 0) setTimeout(() => emitter.emit('exit', code, null), delayMs)
    }
    return emitter
  }
  const packument = () =>
    new Response(JSON.stringify({ 'dist-tags': { latest: '1.2.3' } }), { status: 200 })
  const setup = (
    responses: Array<Response | (() => Response)>,
    children = [child(), child(0, -1)],
  ) => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const queue = [...responses]
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      calls.push({
        url: String(url),
        authorization: new Headers(options?.headers).get('Authorization'),
      })
      const next = queue.shift()!
      return typeof next === 'function' ? next() : next
    })
    const spawn = vi.fn().mockImplementation(() => {
      const next = children.shift() as ReturnType<typeof child> & { start: () => void }
      next.start()
      return next
    })
    const browser = vi.fn(async () => {
      throw new Error('no browser in synthetic runtime tests')
    })
    const deps: RuntimeDependencies = {
      request,
      spawn: spawn as unknown as RuntimeDependencies['spawn'],
      client: new OAuthClient(config, store, browser, request),
      log: vi.fn(),
      timeouts: { connectivityMs: 1_000, metadataMs: 1_000, downloadMs: 200 },
    }
    return { deps, calls, spawn, browser }
  }
  const signal = () => new AbortController().signal

  it('authenticates before download and starts exact version with v1 handoff', async () => {
    await seed()
    const { deps, calls, spawn, browser } = setup([new Response('ok'), packument()])
    await startOAuthRuntime(config, ['--x'], deps, signal())
    expect(calls.map((c) => c.url)).toEqual([
      'https://example.com/',
      'https://example.com/artifacts/api/repositories/ri.artifacts.repository.discovered.foundry-mcp/contents/release/npm/%40palantir%2Fmcp',
    ])
    expect(calls[0].authorization).toBeNull()
    expect(calls[1].authorization).toBe('Bearer stored-access')
    expect(browser).not.toHaveBeenCalled()
    const [prefetch, final] = spawn.mock.calls
    expect(prefetch[0]).toBe('npx')
    expect(prefetch[1]).toEqual([
      '-y',
      '--package',
      '@palantir/mcp@1.2.3',
      '--',
      'node',
      '--version',
    ])
    expect(prefetch[2].stdio).toEqual(['ignore', 'ignore', 'inherit'])
    expect(final[1]).toEqual([
      '-y',
      '--prefer-offline',
      '@palantir/mcp@1.2.3',
      ...privateRuntimeArgs(config, ['--x']),
    ])
    expect(final[2].stdio).toBe('inherit')
    for (const [, args, options] of spawn.mock.calls) {
      expect(options.env.FOUNDRY_TOKEN).toBeUndefined()
      expect(JSON.stringify(args)).not.toContain('stored-')
      expect(
        Object.entries(options.env as Record<string, string>).filter(([, v]) =>
          v.startsWith('stored-'),
        ),
      ).toEqual([
        [expect.stringMatching(/^NPM_CONFIG_\/\/example\.com\/.*:_authToken$/), 'stored-access'],
      ])
    }
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining(`Requested but not granted: ${EXECUTE}`),
    )
  })

  it('refreshes an access token that would expire during the bounded download', async () => {
    await seed({ expiresAt: Date.now() + 30_000 })
    const token = new Response(
      JSON.stringify({
        access_token: 'fresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: READ,
      }),
    )
    const { deps, calls } = setup([new Response('ok'), token, packument()])
    await startOAuthRuntime(config, [], deps, signal())
    expect(calls[1].url).toBe('https://example.com/discovered/token')
    expect(calls[2].authorization).toBe('Bearer fresh')
  })

  it.each([[EXECUTE], [], null])('allows reduced or unknown grants: %j', async (grant) => {
    await seed({ grantedScopes: grant === null ? null : Array.isArray(grant) ? grant : [grant] })
    const { deps, spawn, browser } = setup([new Response('ok'), packument()])
    await startOAuthRuntime(config, [], deps, signal())
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(browser).not.toHaveBeenCalled()
  })

  it('403 from the registry fails without refresh, browser or legacy attempt', async () => {
    await seed()
    const { deps, calls, spawn, browser } = setup([
      new Response('ok'),
      new Response('{}', { status: 403 }),
    ])
    await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow('does not permit')
    expect(calls).toHaveLength(2)
    expect(spawn).not.toHaveBeenCalled()
    expect(browser).not.toHaveBeenCalled()
    expect((await store.read())?.accessToken).toBe('stored-access')
  })

  it('401 refreshes once without consent and retries metadata once', async () => {
    await seed()
    const token = new Response(
      JSON.stringify({
        access_token: 'fresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: READ,
      }),
    )
    const { deps, calls, browser } = setup([
      new Response('ok'),
      new Response('', { status: 401 }),
      token,
      packument(),
    ])
    await startOAuthRuntime(config, [], deps, signal())
    expect(calls.map((c) => c.authorization)).toEqual([
      null,
      'Bearer stored-access',
      null,
      'Bearer fresh',
    ])
    expect(browser).not.toHaveBeenCalled()
  })

  it('repeated 401 fails rather than looping', async () => {
    await seed()
    const token = () =>
      new Response(
        JSON.stringify({
          access_token: 'fresh',
          token_type: 'bearer',
          expires_in: 3600,
          scope: READ,
        }),
      )
    const { deps, calls, spawn } = setup([
      new Response('ok'),
      new Response('', { status: 401 }),
      token,
      new Response('', { status: 401 }),
    ])
    await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow('refreshed')
    expect(calls).toHaveLength(4)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects metadata without a valid exact version', async () => {
    await seed()
    const { deps, spawn } = setup([
      new Response('ok'),
      new Response(JSON.stringify({ 'dist-tags': { latest: '../../x' } })),
    ])
    await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow('no valid latest')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('bounds the download stage and never starts the server after a timeout', async () => {
    await seed()
    const hung = child(0, -1)
    const { deps, spawn } = setup([new Response('ok'), packument()], [hung])
    await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow(OAuthStartupError)
    expect(hung.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('fails closed when the download exits nonzero', async () => {
    await seed()
    const { deps, spawn } = setup([new Response('ok'), packument()], [child(1)])
    await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow('download failed')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('cancellation during download kills the stage and does not start the server', async () => {
    await seed()
    const controller = new AbortController()
    const hung = child(0, -1)
    const { deps, spawn } = setup([new Response('ok'), packument()], [hung])
    deps.timeouts.downloadMs = 60_000
    const running = startOAuthRuntime(config, [], deps, controller.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    controller.abort()
    await expect(running).rejects.toThrow('cancelled')
    expect(hung.kill).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
  })

  describe('on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!
    let node: string
    beforeEach(async () => {
      node = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-node-'))
      Object.defineProperty(process, 'platform', { value: 'win32' })
      Object.defineProperty(process, 'execPath', {
        value: path.join(node, 'node.exe'),
        configurable: true,
      })
    })
    afterEach(async () => {
      Object.defineProperty(process, 'platform', platform)
      Object.defineProperty(process, 'execPath', execPath)
      await fs.rm(node, { recursive: true, force: true })
    })

    it('runs npm npx-cli.js with this Node, without a shell or detached console', async () => {
      const cli = path.join(node, 'node_modules', 'npm', 'bin', 'npx-cli.js')
      await fs.mkdir(path.dirname(cli), { recursive: true })
      await fs.writeFile(cli, '')
      await seed()
      const { deps, spawn } = setup([new Response('ok'), packument()])
      await startOAuthRuntime(config, ['--x'], deps, signal())
      const [prefetch, final] = spawn.mock.calls
      expect(prefetch[0]).toBe(process.execPath)
      expect(prefetch[1]).toEqual([
        cli,
        '-y',
        '--package',
        '@palantir/mcp@1.2.3',
        '--',
        'node',
        '--version',
      ])
      expect(prefetch[2]).toMatchObject({ shell: false, detached: false, windowsHide: true })
      expect(final[0]).toBe(process.execPath)
      // The space-separated scopes stay one argument because no shell re-parses argv.
      expect(final[1]).toEqual([
        cli,
        '-y',
        '--prefer-offline',
        '@palantir/mcp@1.2.3',
        ...privateRuntimeArgs(config, ['--x']),
      ])
      expect(final[2]).toMatchObject({ shell: false })
    })

    it('fails clearly before spawning when Node has no bundled npm', async () => {
      await seed()
      const { deps, spawn } = setup([new Response('ok'), packument()])
      await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow(
        'npm installation bundled with Node.js',
      )
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  it('no stored credential and failed consent never falls back to legacy', async () => {
    const { deps, calls, spawn, browser } = setup([new Response('ok')])
    await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow(
      'no legacy fallback',
    )
    expect(browser).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  const tokenReply = (scope?: string) =>
    new Response(
      JSON.stringify({
        access_token: 'fresh',
        token_type: 'bearer',
        expires_in: 3600,
        ...(scope === undefined ? {} : { scope }),
      }),
    )
  const trackedBody = (text = '', status = 200) => {
    const state = { cancelled: false }
    const body = new ReadableStream({
      start(controller) {
        if (text) controller.enqueue(new TextEncoder().encode(text))
      },
      cancel() {
        state.cancelled = true
      },
    })
    return { response: new Response(body, { status }), state }
  }

  describe('metadata deadline and body handling', () => {
    it('stalled metadata body times out within the stage deadline, even if transport ignores abort', async () => {
      await seed()
      let requestSignal: AbortSignal | undefined
      const { deps, spawn } = setup([])
      deps.timeouts.metadataMs = 20
      deps.request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        requestSignal = init?.signal ?? undefined
        // A response whose body never finishes and never observes the signal.
        return {
          ok: true,
          status: 200,
          body: null,
          json: () => new Promise(() => {}),
        } as unknown as Response
      })
      const started = Date.now()
      await expect(
        resolvePrivatePackage(
          new URL('https://example.com/npm/'),
          (await store.read())!,
          deps,
          signal(),
        ),
      ).rejects.toThrow('timed out')
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(requestSignal?.aborted).toBe(true)
      expect(spawn).not.toHaveBeenCalled()
    })

    it('slow but valid body past the deadline is rejected rather than accepted', async () => {
      await seed()
      const { deps } = setup([])
      deps.timeouts.metadataMs = 10
      deps.request = vi.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
        json: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ 'dist-tags': { latest: '1.0.0' } }), 60),
          ),
      } as unknown as Response)
      await expect(
        resolvePrivatePackage(
          new URL('https://example.com/npm/'),
          (await store.read())!,
          deps,
          signal(),
        ),
      ).rejects.toThrow('timed out')
    })

    it('stalled headers time out even if the transport ignores the abort signal', async () => {
      await seed()
      const { deps } = setup([])
      deps.timeouts.metadataMs = 10
      deps.request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
      await expect(
        resolvePrivatePackage(
          new URL('https://example.com/npm/'),
          (await store.read())!,
          deps,
          signal(),
        ),
      ).rejects.toThrow('failed, timed out or was cancelled')
    })

    it('cancels 401 bodies before refresh/retry and error bodies before throwing', async () => {
      await seed()
      const unauthorized = trackedBody('synthetic-secret', 401)
      const forbidden = trackedBody('synthetic-secret', 403)
      const { deps } = setup([
        new Response('ok'),
        unauthorized.response,
        tokenReply(READ),
        forbidden.response,
      ])
      await expect(startOAuthRuntime(config, [], deps, signal())).rejects.toThrow('does not permit')
      expect(unauthorized.state.cancelled).toBe(true)
      expect(forbidden.state.cancelled).toBe(true)
    })

    it('cancels the unread connectivity body', async () => {
      await seed()
      const reachable = trackedBody('landing page')
      const { deps } = setup([reachable.response, packument()])
      await startOAuthRuntime(config, [], deps, signal())
      expect(reachable.state.cancelled).toBe(true)
    })
  })

  describe('401 refresh grant changes', () => {
    it.each([
      { name: 'narrowed to empty', scope: '' },
      { name: 'unreported', scope: undefined },
      { name: 'narrowed to another scope', scope: EXECUTE },
    ])('starts with the reported refreshed grant when it is $name', async ({ scope }) => {
      await seed()
      const { deps, calls, spawn, browser } = setup([
        new Response('ok'),
        new Response('', { status: 401 }),
        tokenReply(scope),
        packument(),
      ])
      await startOAuthRuntime(config, [], deps, signal())
      expect(calls).toHaveLength(4)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(browser).not.toHaveBeenCalled()
      expect(deps.log).toHaveBeenLastCalledWith(
        expect.stringContaining('refreshed after registry 401'),
      )
      // The narrowed grant is persisted for the next launch and for the private runtime.
      expect((await store.read())?.grantedScopes).toEqual(
        scope === undefined ? null : scope ? [scope] : [],
      )
    })

    it('allows a reduced grant and reports it', async () => {
      await seed({ grantedScopes: [READ, EXECUTE] })
      const { deps, spawn } = setup([
        new Response('ok'),
        new Response('', { status: 401 }),
        tokenReply(READ),
        packument(),
      ])
      await startOAuthRuntime(config, [], deps, signal())
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining(
          `refreshed after registry 401. OAuth grant: ${READ}. Requested but not granted: ${EXECUTE}`,
        ),
      )
    })
  })

  describe('cancellation and bounded termination', () => {
    it('already-aborted startup issues no request, acquisition or spawn', async () => {
      await seed()
      const controller = new AbortController()
      controller.abort()
      const { deps, calls, spawn } = setup([new Response('ok'), packument()])
      const acquire = vi.spyOn(deps.client, 'acquire')
      await expect(startOAuthRuntime(config, [], deps, controller.signal)).rejects.toThrow(
        'cancelled',
      )
      expect(calls).toEqual([])
      expect(acquire).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    })

    it('already-aborted download stage never spawns', async () => {
      const controller = new AbortController()
      controller.abort()
      const { deps, spawn } = setup([])
      await expect(
        prefetchPrivatePackage('@palantir/mcp@1.2.3', {}, deps, controller.signal),
      ).rejects.toThrow('cancelled')
      expect(spawn).not.toHaveBeenCalled()
    })

    it('abort racing with spawn still terminates and settles the owned download', async () => {
      const controller = new AbortController()
      const signals: string[] = []
      const owned = child(0, -1)
      const { deps } = setup([], [owned])
      deps.killProcessGroup = (target, name) => {
        signals.push(name)
        if (name === 'SIGTERM') target.emit('exit', null, name)
      }
      const spawn = deps.spawn
      deps.spawn = ((...args: Parameters<typeof spawn>) => {
        const result = spawn(...args)
        controller.abort() // lands before prefetch attaches its listener
        return result
      }) as typeof spawn
      await expect(
        prefetchPrivatePackage('@palantir/mcp@1.2.3', {}, deps, controller.signal),
      ).rejects.toThrow('cancelled')
      expect(signals[0]).toBe('SIGTERM')
    })

    it('escalates ignored SIGTERM to SIGKILL and settles after the timeout', async () => {
      const signals: string[] = []
      const stubborn = child(0, -1)
      const { deps } = setup([], [stubborn])
      deps.timeouts = { ...deps.timeouts, downloadMs: 20, killGraceMs: 20 }
      deps.killProcessGroup = (target, name) => {
        signals.push(name)
        if (name === 'SIGKILL') setImmediate(() => target.emit('exit', null, name))
      }
      await expect(
        prefetchPrivatePackage('@palantir/mcp@1.2.3', {}, deps, signal()),
      ).rejects.toThrow('timed out')
      expect(signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL'])
    })

    it('settles in bounded time even if the process never reports exit', async () => {
      const { deps } = setup([], [child(0, -1)])
      deps.timeouts = { ...deps.timeouts, downloadMs: 10, killGraceMs: 10 }
      deps.killProcessGroup = () => {}
      const started = Date.now()
      await expect(
        prefetchPrivatePackage('@palantir/mcp@1.2.3', {}, deps, signal()),
      ).rejects.toThrow('did not exit after SIGKILL')
      expect(Date.now() - started).toBeLessThan(1_000)
    })

    it('does not time out the MCP server after a successful download', async () => {
      await seed()
      const server = child(0, -1)
      const { deps, spawn } = setup([new Response('ok'), packument()], [child(), server])
      deps.timeouts = { ...deps.timeouts, downloadMs: 10, killGraceMs: 10 }
      const kill = vi.fn()
      deps.killProcessGroup = kill
      const started = await startOAuthRuntime(config, [], deps, signal())
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(started).toBe(server)
      expect(server.kill).not.toHaveBeenCalled()
      expect(kill).not.toHaveBeenCalled()
      expect(spawn.mock.calls[0][2].detached).toBe(true)
      expect(spawn.mock.calls[1][2].detached).toBeUndefined()
    })
  })
})

describe('download process-group termination (real processes)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  it.skipIf(process.platform === 'win32')(
    'kills an npm-like child and descendant that ignore SIGTERM, leaving unrelated processes',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-group-'))
      const pids = path.join(directory, 'pids')
      // Leader and grandchild both ignore SIGTERM, like a wedged npm lifecycle script.
      const grandchild = `process.on('SIGTERM',()=>{});require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');setInterval(()=>{},1000)`
      const leader = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');setInterval(()=>{},1000)`
      const unrelated = realSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      })
      let owned: ChildProcess | undefined
      try {
        const deps = {
          timeouts: {
            connectivityMs: 1_000,
            metadataMs: 1_000,
            downloadMs: 2_500,
            killGraceMs: 200,
          },
          spawn: ((_command: string, _args: string[], options: object) => {
            owned = realSpawn(process.execPath, ['-e', leader], options)
            return owned
          }) as unknown as RuntimeDependencies['spawn'],
          killProcessGroup,
        } as unknown as RuntimeDependencies
        const started = Date.now()
        await expect(
          prefetchPrivatePackage(
            '@palantir/mcp@1.2.3',
            process.env,
            deps,
            new AbortController().signal,
          ),
        ).rejects.toThrow('timed out')
        expect(Date.now() - started).toBeLessThan(5_000)
        const recorded = (await fs.readFile(pids, 'utf8')).trim().split('\n').map(Number)
        expect(recorded).toHaveLength(2)
        await vi.waitFor(() => expect(recorded.filter(alive)).toEqual([]), { timeout: 2_000 })
        expect(alive(unrelated.pid!)).toBe(true)
      } finally {
        unrelated.kill('SIGKILL')
        if (owned?.pid) killProcessGroup(owned, 'SIGKILL')
        await fs.rm(directory, { recursive: true, force: true })
      }
    },
    10_000,
  )
})
