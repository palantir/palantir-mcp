/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { privateRuntimeArgs, selectRuntime } from '../arguments.js'
import { OAuthClient } from '../client.js'
import { authConfig, OAuthConfig, TOOL_PERMISSION_GROUP_NAMES } from '../config.js'
import {
  MINIMUM_OAUTH_PACKAGE_VERSION,
  oauthChildEnvironment,
  resolvePrivatePackage,
  runOAuthRuntime,
} from '../runtime.js'
import { Credential, OAuthStore } from '../store.js'
import { oauthMetadata } from './fixtures/oauthMetadata.js'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: vi.fn() }
})

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>
const READ = 'palantir-mcp:read-metadata'
const EXECUTE = 'palantir-mcp:execute'
const select = (args: string[]) => selectRuntime(['node', 'wrapper', ...args])
const oauth = (args: string[]) => {
  const selection = select(args)
  if (selection.mode !== 'oauth') throw new Error('expected oauth')
  return selection
}
const handoff = [
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
]

describe('--auth mode selection', () => {
  it('defaults to legacy and preserves argv byte-for-byte', () => {
    const argv = [
      'node',
      'w',
      '--foundry-api-url',
      'http://h/p',
      '--foundry-token',
      'secret',
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
    [['--oauth-unknown=1']],
    [['--auth=legacy', '--oauth-scopes', 'palantir-mcp:read-metadata']],
  ])('rejects %j rather than falling back', (args) => {
    expect(() => select(args)).toThrow()
  })
  it('rejects a foundry token in OAuth mode without echoing it', () => {
    expect(() =>
      select([
        '--auth=oauth',
        '--foundry-api-url',
        'https://example.com',
        '--foundry-token',
        'synthetic-secret',
      ]),
    ).toThrow('conflicts with --foundry-token')
    try {
      select([
        '--auth=oauth',
        '--foundry-api-url',
        'https://example.com',
        '--foundry-token=synthetic-secret',
      ])
    } catch (error) {
      expect((error as Error).message).not.toContain('synthetic-secret')
    }
  })
  it('rejects removed OAuth overrides and keeps scopes in the pinned handoff', () => {
    for (const flag of ['--oauth-client-id', '--oauth-redirect', '--oauth-profile']) {
      expect(() =>
        select(['--auth=oauth', '--foundry-api-url', 'https://example.com', flag, 'x']),
      ).toThrow('--oauth-scopes only')
    }
    const { config, forwardedArgs } = oauth([
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--disable-tools',
      'a',
      '--oauth-scopes',
      `${READ} ${EXECUTE}`,
    ])
    expect(forwardedArgs).toEqual(['--disable-tools', 'a'])
    expect(config.scopes).toEqual([EXECUTE, READ, 'offline_access'].sort())
    expect(privateRuntimeArgs(authConfig('https://example.com'), [])).toEqual(handoff)
    expect(privateRuntimeArgs(config, ['--x'])).toEqual([
      'start',
      'local-development',
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-client-id',
      config.clientId,
      '--oauth-redirect',
      config.redirect,
      '--oauth-profile',
      'default',
      '--oauth-scopes',
      config.scopes.join(' '),
      '--x',
    ])
  })
})

describe('OAuth child environment', () => {
  it('strips inherited legacy and npm tokens and sets only the registry-scoped token', () => {
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

describe('private package resolution and startup', () => {
  let directory: string
  let config: OAuthConfig
  let store: OAuthStore
  const listeners = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  }
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-runtime-'))
    config = authConfig('https://example.com')
    store = new OAuthStore(config, directory)
    mockSpawn.mockReset()
    process.exitCode = undefined
  })
  afterEach(async () => {
    for (const event of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(event)) {
        if (!listeners[event].includes(listener)) process.removeListener(event, listener)
      }
    }
    process.exitCode = undefined
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
  const packument = (latest = '1.2.3') =>
    new Response(JSON.stringify({ 'dist-tags': { latest } }), { status: 200 })
  const token = () =>
    new Response(
      JSON.stringify({
        access_token: 'fresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: READ,
      }),
    )
  const child = () => {
    const emitter = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
    emitter.kill = vi.fn(() => true)
    return emitter
  }
  const requestFor = (responses: Array<Response | (() => Response)>) => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const queue = [...responses]
    const browser = vi.fn(async () => {
      throw new Error('no browser')
    })
    const request = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      calls.push({
        url: String(url),
        authorization: new Headers(options?.headers).get('Authorization'),
      })
      const next = queue.shift()
      if (!next) throw new Error(`unexpected request ${String(url)}`)
      return typeof next === 'function' ? next() : next
    })
    const client = new OAuthClient(config, store, browser, request)
    return { calls, browser, request, client }
  }
  const registry = new URL(
    'https://example.com/artifacts/api/repositories/ri.artifacts.repository.discovered.foundry-mcp/contents/release/npm/',
  )

  it('acquires credentials before package access and starts the exact version once', async () => {
    await seed()
    const server = child()
    mockSpawn.mockReturnValue(server)
    const { calls, browser, client } = requestFor([packument()])
    await runOAuthRuntime(config, ['--x'], client)
    expect(calls.map((call) => call.url)).toEqual([
      `${registry.origin}${registry.pathname}%40palantir%2Fmcp`,
    ])
    expect(calls[0].authorization).toBe('Bearer stored-access')
    expect(browser).not.toHaveBeenCalled()
    expect(mockSpawn).toHaveBeenCalledOnce()
    expect(mockSpawn.mock.calls[0][1]).toEqual([
      '-y',
      '@palantir/mcp@1.2.3',
      ...privateRuntimeArgs(config, ['--x']),
    ])
    expect(mockSpawn.mock.calls[0][1]).not.toContain('--prefer-offline')
    expect(mockSpawn.mock.calls[0][2]).toMatchObject({ stdio: 'inherit', shell: false })
    expect(mockSpawn.mock.calls[0][2].env.FOUNDRY_TOKEN).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.kill).not.toHaveBeenCalled()
  })

  it('refreshes a token inside the 60 second window before registry access', async () => {
    await seed({ expiresAt: Date.now() + 30_000 })
    mockSpawn.mockReturnValue(child())
    const { calls, browser, client } = requestFor([token(), packument()])
    await runOAuthRuntime(config, [], client)
    expect(calls[0].url).toContain('/discovered/token')
    expect(calls[1].authorization).toBe('Bearer fresh')
    expect(browser).not.toHaveBeenCalled()
    expect(mockSpawn).toHaveBeenCalledOnce()
  })

  it('refreshes once on 401 and does not refresh on 403', async () => {
    await seed()
    const refreshed = requestFor([new Response('', { status: 401 }), token(), packument()])
    await expect(
      resolvePrivatePackage(
        registry,
        refreshed.client,
        (await store.read())!,
        new AbortController().signal,
        refreshed.request,
      ),
    ).resolves.toMatchObject({ version: '1.2.3', credential: { accessToken: 'fresh' } })
    expect(refreshed.calls.map((call) => call.authorization)).toEqual([
      'Bearer stored-access',
      null,
      'Bearer fresh',
    ])
    expect(refreshed.browser).not.toHaveBeenCalled()

    await seed()
    const forbidden = requestFor([new Response('', { status: 403 })])
    await expect(
      resolvePrivatePackage(
        registry,
        forbidden.client,
        (await store.read())!,
        new AbortController().signal,
        forbidden.request,
      ),
    ).rejects.toThrow('does not permit')
    expect(forbidden.calls).toHaveLength(1)
    expect(forbidden.browser).not.toHaveBeenCalled()
    expect((await store.read())?.accessToken).toBe('stored-access')
  })

  it('fails a repeated 401 instead of looping', async () => {
    await seed()
    const { calls, client, request } = requestFor([
      new Response('', { status: 401 }),
      token(),
      new Response('', { status: 401 }),
    ])
    await expect(
      resolvePrivatePackage(
        registry,
        client,
        (await store.read())!,
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow('refreshed')
    expect(calls).toHaveLength(3)
  })

  it.each([
    ['../../x', 'no valid latest'],
    ['0.576.9', 'Use token authentication'],
    ['0.577.0-rc.1', 'Use token authentication'],
  ])('refuses %s with no package start', async (latest, message) => {
    await seed()
    mockSpawn.mockReturnValue(child())
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((value) => {
      errors.push(String(value))
    })
    const { client } = requestFor([packument(latest)])
    await runOAuthRuntime(config, [], client)
    expect(process.exitCode).toBe(1)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain(message)
    expect(errors.join('\n')).toContain(
      latest === '../../x' ? 'no valid latest' : MINIMUM_OAUTH_PACKAGE_VERSION,
    )
  })

  it('accepts the minimum OAuth package version', async () => {
    await seed()
    const { client, request } = requestFor([packument(MINIMUM_OAUTH_PACKAGE_VERSION)])
    await expect(
      resolvePrivatePackage(
        registry,
        client,
        (await store.read())!,
        new AbortController().signal,
        request,
      ),
    ).resolves.toMatchObject({ version: MINIMUM_OAUTH_PACKAGE_VERSION })
  })

  it('does not start the package when consent fails', async () => {
    const listener = (await import('node:net')).createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    const custom = {
      ...config,
      redirect: `http://127.0.0.1:${port}/oauth2redirect/palantir-mcp`,
    }
    const customStore = new OAuthStore(custom, directory)
    const browser = vi.fn(async () => {
      throw new Error('no browser')
    })
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      throw new Error(`unexpected ${String(url)}`)
    })
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message) => errors.push(String(message)))
    await runOAuthRuntime(custom, [], new OAuthClient(custom, customStore, browser, request))
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('no legacy fallback')
    expect(browser).toHaveBeenCalledOnce()
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})
