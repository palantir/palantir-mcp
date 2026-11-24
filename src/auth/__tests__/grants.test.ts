/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuthClient, parseGrantedScopes } from '../client.js'
import { authConfig, OAuthConfig } from '../config.js'
import { credentialBinding, Credential, OAuthStore } from '../store.js'
import { withMetadata } from './fixtures/oauthMetadata.js'
import { SHARED_CREDENTIAL_JSON } from './fixtures/sharedCredential.js'

const READ = 'palantir-mcp:read-metadata'
const DATA = 'palantir-mcp:read-data'
const EXECUTE = 'palantir-mcp:execute'

let directory: string
let config: OAuthConfig
let store: OAuthStore

const reply = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      token_type: 'Bearer',
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
  grantedScopes: [READ, EXECUTE],
  ...extra,
})
const seed = (extra: Partial<Credential> = {}) => store.locked(() => store.write(record(extra)))
const noBrowser = vi.fn(async () => {
  throw new Error('synthetic tests never open a browser')
})
/** Login without a browser: the fake browser immediately hits the loopback callback. */
const loopbackBrowser = async (authorization: string) => {
  const auth = new URL(authorization)
  const url = new URL(auth.searchParams.get('redirect_uri')!)
  url.search = new URLSearchParams({
    state: auth.searchParams.get('state')!,
    code: 'synthetic-code',
  }).toString()
  await fetch(url)
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-grants-'))
  config = authConfig({
    foundryApiUrl: 'https://example.com',
    oauthClientId: 'fixture',
    oauthRedirect: `http://127.0.0.1:${40000 + Math.floor(Math.random() * 9000)}/callback`,
    oauthScopes: `${READ} ${DATA} ${EXECUTE}`,
  })
  store = new OAuthStore(config, directory)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('returned operation grants', () => {
  it('keeps requested scopes (with offline_access) separate from reported grants', () => {
    expect(config.scopes).toEqual([DATA, EXECUTE, READ, 'offline_access'].sort())
    expect(parseGrantedScopes(`${READ} offline_access ${READ}`)).toEqual([READ])
    expect(parseGrantedScopes(undefined)).toBeNull()
    expect(parseGrantedScopes('')).toEqual([])
    expect(() => parseGrantedScopes(['x'])).toThrow()
  })

  it.each([
    { name: 'reduced optional grant without offline_access', scope: READ, granted: [READ] },
    {
      name: 'full operation grant',
      scope: `${EXECUTE} ${DATA} ${READ}`,
      granted: [EXECUTE, DATA, READ],
    },
    { name: 'omitted scope (unknown, not inferred)', scope: undefined, granted: null },
    { name: 'explicit empty grant', scope: '', granted: [] },
    {
      name: 'unrequested extra name recorded literally',
      scope: `${READ} other:op`,
      granted: ['other:op', READ],
    },
  ])('login accepts $name', async ({ scope, granted }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(scope === undefined ? {} : { scope }))
    const credential = await new OAuthClient(
      config,
      store,
      loopbackBrowser,
      withMetadata(request),
    ).login()
    expect(credential.grantedScopes).toEqual(granted)
    expect(await store.read()).toMatchObject({
      version: 1,
      requestedScopes: config.scopes,
      grantedScopes: granted,
      refreshToken: 'synthetic-refresh',
    })
  })

  it('login without a refresh token still stores the access token; refresh is distinct', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => reply({ refresh_token: undefined, scope: READ }))
    const client = new OAuthClient(config, store, loopbackBrowser, withMetadata(request))
    const credential = await client.login()
    expect(credential.refreshToken).toBeUndefined()
    expect(credential.grantedScopes).toEqual([READ])
    await client.refresh()
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('refresh grant changes', () => {
  it('explicit refresh waits for full browser authorization when credentials are missing', async () => {
    let allowConsent!: () => void
    let browserOpened!: () => void
    const consent = new Promise<void>((resolve) => {
      allowConsent = resolve
    })
    const opened = new Promise<void>((resolve) => {
      browserOpened = resolve
    })
    const browser = async (url: string) => {
      browserOpened()
      await consent
      await loopbackBrowser(url)
    }
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply({ scope: READ }))
    const client = new OAuthClient(config, store, browser, withMetadata(request))
    let finished = false
    const refresh = client.refresh().then((credential) => {
      finished = true
      return credential
    })
    try {
      await opened
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(finished).toBe(false)
      expect(request).not.toHaveBeenCalled()
    } finally {
      allowConsent()
    }
    expect(await refresh).toMatchObject({ accessToken: 'synthetic-access' })
    expect(finished).toBe(true)
    expect(await store.read()).toMatchObject({ accessToken: 'synthetic-access' })
  })

  it.each([
    { name: 'narrowed', scope: READ, granted: [READ] },
    { name: 'widened', scope: `${READ} ${DATA} ${EXECUTE}`, granted: [EXECUTE, DATA, READ] },
    { name: 'omitted (null, not previous)', scope: undefined, granted: null },
    { name: 'empty', scope: '', granted: [] },
  ])('persists $name grant and rotated token', async ({ scope, granted }) => {
    await seed()
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({ refresh_token: 'rotated', ...(scope === undefined ? {} : { scope }) }),
      )
    const credential = await new OAuthClient(
      config,
      store,
      noBrowser,
      withMetadata(request),
    ).refresh()
    expect(credential).toMatchObject({ grantedScopes: granted, refreshToken: 'rotated' })
    expect(await store.read()).toMatchObject({ grantedScopes: granted, refreshToken: 'rotated' })
    const body = request.mock.calls[0][1]?.body as URLSearchParams
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(body.has('scope')).toBe(false)
  })

  it('retains the old refresh token only on a successful response without replacement', async () => {
    await seed()
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ refresh_token: undefined, scope: READ }))
    await new OAuthClient(config, store, noBrowser, withMetadata(request)).refresh()
    expect(await store.read()).toMatchObject({
      refreshToken: 'old-refresh',
      accessToken: 'synthetic-access',
    })
  })
})

describe('startup credential acquisition', () => {
  it('returns a still-valid stored credential without network or browser', async () => {
    await seed({ expiresAt: Date.now() + 3_600_000 })
    const request = vi.fn<typeof fetch>()
    const credential = await new OAuthClient(
      config,
      store,
      noBrowser,
      withMetadata(request),
    ).acquire({})
    expect(credential.accessToken).toBe('old-access')
    expect(request).not.toHaveBeenCalled()
  })

  it('refreshes when expiring within the requested validity window', async () => {
    await seed({ expiresAt: Date.now() + 120_000 })
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply({ scope: READ }))
    const credential = await new OAuthClient(
      config,
      store,
      noBrowser,
      withMetadata(request),
    ).acquire({
      minValidityMs: 360_000,
    })
    expect(credential.accessToken).toBe('synthetic-access')
    expect(request).toHaveBeenCalledOnce()
  })

  it('never returns a rejected access token and refreshes without consent', async () => {
    await seed({ expiresAt: Date.now() + 3_600_000 })
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply())
    const credential = await new OAuthClient(
      config,
      store,
      noBrowser,
      withMetadata(request),
    ).acquire({
      rejectedAccessToken: 'old-access',
    })
    expect(credential.accessToken).toBe('synthetic-access')
    expect(noBrowser).not.toHaveBeenCalled()
  })

  it('first acquisition automatically authorizes without a login command', async () => {
    const browser = vi.fn(loopbackBrowser)
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply())
    await new OAuthClient(config, store, browser, withMetadata(request)).acquire()
    expect(browser).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it('after a rejected refresh, interactive startup performs exactly one consent', async () => {
    await seed()
    const browser = vi.fn(loopbackBrowser)
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('denied', { status: 400 }))
      .mockResolvedValueOnce(reply({ scope: READ }))
    const credential = await new OAuthClient(config, store, browser, withMetadata(request)).acquire(
      {},
    )
    expect(credential.grantedScopes).toEqual([READ])
    expect(browser).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'rejected'])(
    'automatically authorizes after a 401 with %s refresh state',
    async (state) => {
      await seed({
        refreshToken: state === 'missing' ? undefined : 'expired-refresh',
        expiresAt: Date.now() + 3_600_000,
      })
      const browser = vi.fn(loopbackBrowser)
      const request = vi.fn<typeof fetch>()
      if (state === 'rejected') request.mockResolvedValueOnce(new Response('', { status: 400 }))
      request.mockImplementation(async () => reply())
      const value = await new OAuthClient(config, store, browser, withMetadata(request)).acquire({
        rejectedAccessToken: 'old-access',
      })
      expect(value.accessToken).toBe('synthetic-access')
      expect(browser).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledTimes(state === 'missing' ? 1 : 2)
    },
  )

  it.each(['network', 'server', 'storage'])(
    'surfaces %s failures instead of hiding them with browser authorization',
    async (kind) => {
      await seed()
      const browser = vi.fn(loopbackBrowser)
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (kind === 'network') throw new Error('synthetic-secret')
        return kind === 'server' ? new Response('', { status: 500 }) : reply()
      })
      if (kind === 'storage')
        vi.spyOn(store, 'write').mockRejectedValue(new Error('storage unavailable'))
      await expect(
        new OAuthClient(config, store, browser, withMetadata(request)).acquire(),
      ).rejects.toThrow(kind === 'storage' ? 'storage unavailable' : 'exchange failed')
      expect(browser).not.toHaveBeenCalled()
      expect(await store.read()).toBeUndefined()
    },
  )

  it('keeps a still-valid token without refresh credential inside the window (no consent)', async () => {
    await seed({ refreshToken: undefined, expiresAt: Date.now() + 120_000 })
    const request = vi.fn<typeof fetch>()
    const credential = await new OAuthClient(
      config,
      store,
      noBrowser,
      withMetadata(request),
    ).acquire({
      minValidityMs: 360_000,
    })
    expect(credential.accessToken).toBe('old-access')
    expect(request).not.toHaveBeenCalled()
    expect(noBrowser).not.toHaveBeenCalled()
    expect(await store.read()).toBeDefined()
  })

  it('returns a refreshed token shorter than the window after exactly one refresh', async () => {
    await seed({ expiresAt: Date.now() + 1_000 })
    const request = vi.fn<typeof fetch>().mockResolvedValue(reply({ expires_in: 120 }))
    const client = new OAuthClient(config, store, noBrowser, withMetadata(request))
    const credential = await client.acquire({ minValidityMs: 360_000 })
    expect(credential.accessToken).toBe('synthetic-access')
    expect(request).toHaveBeenCalledOnce()
    expect(noBrowser).not.toHaveBeenCalled()
  })

  it('a rejected or nearly expired token without refresh credential is never returned', async () => {
    for (const extra of [
      { expiresAt: Date.now() + 30_000 },
      { expiresAt: Date.now() + 3_600_000, rejected: true },
    ]) {
      await seed({ refreshToken: undefined, expiresAt: extra.expiresAt })
      const client = new OAuthClient(config, store, noBrowser, withMetadata(vi.fn()))
      await expect(
        client.acquire({ rejectedAccessToken: extra.rejected ? 'old-access' : undefined }),
      ).rejects.toThrow('synthetic tests never open a browser')
      expect(await store.read()).toBeUndefined()
    }
    expect(noBrowser).toHaveBeenCalledTimes(2)
  })

  it('token exchange deadline covers a stalled response body and invalidates state', async () => {
    await seed()
    const request = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      json: () => new Promise(() => {}),
    } as unknown as Response)
    const client = new OAuthClient(config, store, noBrowser, withMetadata(request), 1_000, 20)
    const started = Date.now()
    await expect(client.refresh()).rejects.toThrow('exchange failed')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await store.read()).toBeUndefined()
  })

  it('cancels a rejected token-endpoint body', async () => {
    await seed()
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 400 }))
    await expect(
      new OAuthClient(config, store, noBrowser, withMetadata(request)).refresh(),
    ).rejects.toThrow()
    expect(cancelled).toBe(true)
  })

  it('serializes with a second store instance holding the same lock', async () => {
    await seed({ expiresAt: 0 })
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const old = (options?.body as URLSearchParams).get('refresh_token')
      return reply({ refresh_token: `${old}-next` })
    })
    const [a, b] = await Promise.all([
      new OAuthClient(config, store, noBrowser, withMetadata(request)).acquire(),
      new OAuthClient(
        config,
        new OAuthStore(config, directory),
        noBrowser,
        withMetadata(request),
      ).acquire(),
    ])
    // The second waiter observes the first refresh instead of replaying the consumed token.
    expect(request).toHaveBeenCalledOnce()
    expect(a.accessToken).toBe(b.accessToken)
  })

  it('does not steal a held lock', async () => {
    let release!: () => void
    const held = store.locked(() => new Promise<void>((resolve) => (release = resolve)))
    await vi.waitFor(() => expect(release).toBeDefined())
    const fast = new OAuthStore(config, directory, 100)
    await expect(
      new OAuthClient(config, fast, noBrowser, withMetadata(vi.fn())).acquire(),
    ).rejects.toThrow('busy')
    release()
    await held
  })
})

describe('v1 cross-package credential-state contract', () => {
  it('reuses a default-profile record serialized by the private runtime without login', async () => {
    const defaults = authConfig({ foundryApiUrl: 'https://example.com' })
    const value = JSON.parse(SHARED_CREDENTIAL_JSON) as Credential
    const shared = new OAuthStore(defaults, directory)
    expect(shared.binding).toBe('ec10b4f1c38bdf668f7e18b0e8c042e96de3c7713eb3684d3c60f8a3aadb89ce')
    await fs.writeFile(path.join(directory, `${shared.binding}.json`), SHARED_CREDENTIAL_JSON, {
      mode: 0o600,
    })
    const browser = vi.fn()
    const request = vi.fn()
    const credential = await new OAuthClient(
      defaults,
      shared,
      browser,
      withMetadata(request),
    ).acquire()
    expect(credential).toEqual(value)
    await shared.locked(() => shared.write(credential))
    expect(await fs.readFile(path.join(directory, `${shared.binding}.json`), 'utf8')).toBe(
      SHARED_CREDENTIAL_JSON,
    )
    expect(browser).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  // Scope overrides also have a pinned binding digest.
  const fixture = () =>
    authConfig({
      foundryApiUrl: 'https://example.com',
      oauthClientId: 'fixture',
      oauthRedirect: 'http://127.0.0.1:49152/callback',
      oauthScopes: `${READ} ${EXECUTE} ${READ}`,
    })
  const BINDING = '396a7b9a2612552d3bba8da39d6713aaa03a49914760dd93e2d9536aa59b3397'

  it('pins the binding digest and default shared directory', () => {
    expect(credentialBinding(fixture())).toBe(BINDING)
    expect(new OAuthStore(fixture()).binding).toBe(BINDING)
  })

  it('locks the permanent <binding>.lock file that the private runtime locks', async () => {
    const shared = new OAuthStore(fixture(), directory)
    await shared.locked(async () => {})
    expect(await fs.readdir(directory)).toEqual([`${BINDING}.lock`])
  })

  it('writes exactly the v1 record shape at <binding>.json with private modes', async () => {
    const shared = new OAuthStore(fixture(), directory)
    const value: Credential = {
      version: 1,
      binding: BINDING,
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: 1_700_000_000_000,
      requestedScopes: ['offline_access', EXECUTE, READ],
      grantedScopes: [READ],
    }
    await shared.locked(() => shared.write(value))
    const file = path.join(directory, `${BINDING}.json`)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(value)
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')))).toEqual([
      'version',
      'requestedScopes',
      'grantedScopes',
      'binding',
      'accessToken',
      'refreshToken',
      'expiresAt',
    ])
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    }
  })

  it('reads a record produced by the private runtime (grantedScopes null, no refresh token)', async () => {
    const shared = new OAuthStore(fixture(), directory)
    await fs.chmod(directory, 0o700)
    const produced = {
      version: 1,
      requestedScopes: ['offline_access', EXECUTE, READ],
      grantedScopes: null,
      binding: BINDING,
      accessToken: 'A',
      expiresAt: 1,
    }
    await fs.writeFile(path.join(directory, `${BINDING}.json`), JSON.stringify(produced), {
      mode: 0o600,
    })
    expect(await shared.read()).toEqual(produced)
  })

  it.each([
    ['unversioned', { version: undefined }],
    ['future version', { version: 2 }],
    ['other requested scopes', { requestedScopes: ['offline_access'] }],
    ['missing grant metadata', { grantedScopes: undefined }],
  ])('rejects %s state instead of migrating authority', async (_name, change) => {
    const shared = new OAuthStore(fixture(), directory)
    await fs.chmod(directory, 0o700)
    const value = {
      version: 1,
      binding: BINDING,
      accessToken: 'A',
      expiresAt: 1,
      requestedScopes: ['offline_access', EXECUTE, READ],
      grantedScopes: [],
      ...change,
    }
    await fs.writeFile(path.join(directory, `${BINDING}.json`), JSON.stringify(value), {
      mode: 0o600,
    })
    await expect(shared.read()).rejects.toThrow('could not be read safely')
  })
})
