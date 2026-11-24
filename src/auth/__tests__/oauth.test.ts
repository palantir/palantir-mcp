/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuthClient } from '../client.js'
import {
  authConfig,
  OAuthConfig,
  PALANTIR_MCP_CLIENT_ID,
  TOOL_PERMISSION_GROUP_NAMES,
} from '../config.js'
import { Credential, OAuthStore } from '../store.js'
import { withMetadata } from './fixtures/oauthMetadata.js'

let directory: string
let config: OAuthConfig
let store: OAuthStore
const reply = (extra = {}) =>
  new Response(
    JSON.stringify({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      ...extra,
    }),
  )
const record = (extra: Partial<Credential> = {}): Credential => ({
  version: 1,
  binding: store.binding,
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 0,
  requestedScopes: config.scopes,
  grantedScopes: [],
  ...extra,
})
const seed = async (extra: Partial<Credential> = {}) =>
  store.locked(() => store.write(record(extra)))

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-oauth-'))
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  config = authConfig({
    foundryApiUrl: 'https://EXAMPLE.com',
    oauthProfile: 'test',
    oauthRedirect: `http://127.0.0.1:${port}/oauth2redirect/palantir-mcp`,
  })
  store = new OAuthStore(config, directory)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

const callback = async (authorization: string, mutate?: (url: URL) => void) => {
  const auth = new URL(authorization)
  const url = new URL(auth.searchParams.get('redirect_uri')!)
  url.search = new URLSearchParams({
    state: auth.searchParams.get('state')!,
    code: 'synthetic-code',
  }).toString()
  mutate?.(url)
  return fetch(url)
}

describe('public OAuth lifecycle', () => {
  it('uses PKCE and exact public-client contract; stores credentials without legacy access', async () => {
    let authorize!: URL
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply())
    const browser = async (url: string) => {
      authorize = new URL(url)
      await callback(url)
    }
    await new OAuthClient(config, store, browser, withMetadata(request)).login()
    expect(authorize.origin).toBe(config.host)
    expect(authorize.pathname).toBe('/discovered/authorize')
    expect(authorize.searchParams.get('scope')).toBe(config.scopes.join(' '))
    expect(authorize.searchParams.get('client_id')).toBe(PALANTIR_MCP_CLIENT_ID)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    const [target, options] = request.mock.calls[0]
    expect(target).toBe('https://example.com/discovered/token')
    expect(options?.redirect).toBe('error')
    const body = options?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(config.redirect)
    expect(body.has('client_secret')).toBe(false)
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    )
    expect((await store.read())?.accessToken).toBe('synthetic-access')
    await new OAuthClient(config, store).logout()
    expect(await store.read()).toBeUndefined()
  })

  it.each(['state', 'denial', 'missing-code', 'duplicate-code', 'duplicate-state'])(
    'rejects %s and closes listener',
    async (kind) => {
      const request = vi.fn<typeof fetch>()
      const client = new OAuthClient(
        config,
        store,
        async (url) => {
          await callback(url, (returned) => {
            if (kind === 'state') returned.searchParams.set('state', 'wrong')
            if (kind === 'denial') returned.searchParams.set('error', 'access_denied')
            if (kind === 'missing-code') returned.searchParams.delete('code')
            if (kind === 'duplicate-code') returned.searchParams.append('code', 'another')
            if (kind === 'duplicate-state') returned.searchParams.append('state', 'another')
          })
        },
        withMetadata(request),
      )
      await expect(client.login()).rejects.toThrow('authorization')
      expect(request).not.toHaveBeenCalled()
      await expect(fetch(config.redirect)).rejects.toThrow()
      // Only the permanent lock file remains; no credential or temporary file.
      expect(await fs.readdir(directory)).toEqual([`${store.binding}.lock`])
    },
  )

  it('ignores unrelated path and accepts the subsequent exact callback', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply())
    await new OAuthClient(
      config,
      store,
      async (url) => {
        const wrong = await callback(url, (returned) => {
          returned.pathname = '/other'
        })
        expect(wrong.status).toBe(404)
        await callback(url)
      },
      withMetadata(request),
    ).login()
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(['timeout', 'cancel', 'browser'])('cleans up on %s', async (kind) => {
    const controller = new AbortController()
    const client = new OAuthClient(
      config,
      store,
      async () => {
        if (kind === 'cancel') controller.abort()
        if (kind === 'browser') throw new Error('browser unavailable')
      },
      withMetadata(vi.fn()),
      20,
    )
    await expect(client.login(controller.signal)).rejects.toThrow()
    await expect(fetch(config.redirect)).rejects.toThrow()
    expect(await fs.readdir(directory)).toEqual([`${store.binding}.lock`])
  })

  it('serializes independent refresh clients and persists rotation before the next read', async () => {
    await seed()
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const old = (options?.body as URLSearchParams).get('refresh_token')
      return reply({ refresh_token: old + '-rotated' })
    })
    await Promise.all([
      new OAuthClient(config, store, undefined, withMetadata(request)).refresh(),
      new OAuthClient(
        config,
        new OAuthStore(config, directory),
        undefined,
        withMetadata(request),
      ).refresh(),
    ])
    expect((await store.read())?.refreshToken).toBe('old-refresh-rotated-rotated')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each(['invalid-grant', 'network', 'malformed', 'non-string-scope', 'save'])(
    'invalidates uncertain refresh state after %s failure',
    async (kind) => {
      await seed()
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (kind === 'network') throw new Error('synthetic-secret')
        if (kind === 'invalid-grant') return new Response('synthetic-secret', { status: 400 })
        if (kind === 'malformed') return reply({ expires_in: 'synthetic-secret' })
        if (kind === 'non-string-scope') return reply({ scope: ['synthetic'] })
        return reply()
      })
      if (kind === 'save') vi.spyOn(store, 'write').mockRejectedValue(new Error('write failure'))
      const browser = vi.fn(async () => {
        throw new Error('browser unavailable')
      })
      const client = new OAuthClient(config, store, browser, withMetadata(request))
      await expect(client.refresh()).rejects.toThrow()
      expect(await store.read()).toBeUndefined()
      await expect(client.refresh()).rejects.toThrow('browser unavailable')
      expect(request).toHaveBeenCalledOnce()
    },
  )
})

describe('configuration and protected storage', () => {
  it.each(['host', 'clientId', 'profile', 'scopes', 'redirect'] as const)(
    'isolates %s',
    async (key) => {
      await seed()
      const other = {
        ...config,
        [key]: key === 'scopes' ? ['offline_access', 'other'] : config[key] + 'other',
      }
      expect(await new OAuthStore(other, directory).read()).toBeUndefined()
    },
  )
  it('normalizes scope order and duplicates', () => {
    expect(new OAuthStore({ ...config, scopes: ['b', 'a', 'a'] }, directory).binding).toBe(
      new OAuthStore({ ...config, scopes: ['a', 'b'] }, directory).binding,
    )
  })
  it.each(['http://host', 'https://host/path', 'https://user:secret@host', 'https://host?secret'])(
    'rejects unsafe host %s',
    (host) => {
      expect(() =>
        authConfig({
          foundryApiUrl: host,
        }),
      ).toThrow()
    },
  )
  it('defaults to the dedicated public MCP client and exact callback', () => {
    expect(authConfig({ foundryApiUrl: config.host })).toEqual({
      host: config.host,
      clientId: 'e9036da0035845c988db3a6536f08a42',
      redirect: 'http://127.0.0.1:49152/oauth2redirect/palantir-mcp',
      profile: 'default',
      scopes: ['offline_access', ...TOOL_PERMISSION_GROUP_NAMES].sort(),
    })
  })
  it.each([
    { oauthClientId: 'approved' },
    { oauthRedirect: 'http://127.0.0.1:1234/registered' },
    { oauthClientId: 'approved', oauthRedirect: 'http://127.0.0.1:1234/registered' },
  ])('preserves explicit overrides %j', (overrides) => {
    expect(authConfig({ foundryApiUrl: config.host, ...overrides })).toMatchObject({
      clientId: overrides.oauthClientId ?? 'e9036da0035845c988db3a6536f08a42',
      redirect: overrides.oauthRedirect ?? 'http://127.0.0.1:49152/oauth2redirect/palantir-mcp',
    })
  })
  it.each([{ oauthClientId: '' }, { oauthClientId: 'invalid client' }, { oauthRedirect: '' }])(
    'rejects invalid explicit overrides rather than using defaults: %j',
    (overrides) => {
      expect(() => authConfig({ foundryApiUrl: config.host, ...overrides })).toThrow()
    },
  )
  it('requires a safe redirect', () => {
    expect(() =>
      authConfig({
        foundryApiUrl: config.host,
        oauthRedirect: 'http://0.0.0.0:1234/callback',
      }),
    ).toThrow()
  })
  // POSIX only: Windows has no owner/mode bits (see windows.test.ts).
  it.skipIf(process.platform === 'win32')(
    'creates private records and refuses unsafe directories/records and symlinks',
    async () => {
      await seed()
      const file = path.join(directory, `${store.binding}.json`)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      await fs.chmod(file, 0o644)
      await expect(store.read()).rejects.toThrow('safely')
      await fs.rm(file)
      await fs.symlink('/not-a-real-secret-file', file)
      await expect(store.read()).rejects.toThrow('safely')
      await fs.chmod(directory, 0o755)
      await expect(store.locked(async () => {})).rejects.toThrow('unsafe')
    },
  )
  it('redacts malformed records and rejects wrong binding', async () => {
    await seed()
    const file = path.join(directory, `${store.binding}.json`)
    await fs.writeFile(file, 'synthetic-secret')
    await expect(store.read()).rejects.toThrow('could not be read safely')
    await expect(store.write(record({ binding: 'wrong' }))).rejects.toThrow('binding')
    await expect(store.write(record({ requestedScopes: ['other'] }))).rejects.toThrow('binding')
  })
})
