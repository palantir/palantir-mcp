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
import { OAuthClient, parseGrantedScopes } from '../client.js'
import {
  authConfig,
  OAuthConfig,
  PALANTIR_MCP_CLIENT_ID,
  PALANTIR_MCP_REDIRECT,
} from '../config.js'
import { discoverOAuthMetadata } from '../metadata.js'
import { Credential, OAuthStore } from '../store.js'
import { oauthMetadata } from './fixtures/oauthMetadata.js'

let directory: string
let config: OAuthConfig
let store: OAuthStore
const READ = 'palantir-mcp:read-metadata'
const reply = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      scope: READ,
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
  grantedScopes: [READ],
  ...extra,
})
const seed = (extra: Partial<Credential> = {}) => store.locked(() => store.write(record(extra)))
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

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-oauth-'))
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const defaults = authConfig('https://example.com')
  config = { ...defaults, redirect: `http://127.0.0.1:${port}/oauth2redirect/palantir-mcp` }
  store = new OAuthStore(config, directory)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('OAuth acquisition', () => {
  it('uses PKCE S256 once, then stores the credential', async () => {
    let authorize!: URL
    let discovery = 0
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/.well-known/')) {
        discovery++
        return new Response(JSON.stringify(oauthMetadata()))
      }
      return reply()
    })
    const browser = async (url: string) => {
      authorize = new URL(url)
      await callback(url)
    }
    const credential = await new OAuthClient(config, store, browser, request).acquire()
    expect(discovery).toBe(1)
    expect(authorize.pathname).toBe('/discovered/authorize')
    expect(authorize.searchParams.get('client_id')).toBe(PALANTIR_MCP_CLIENT_ID)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('scope')).toBe(config.scopes.join(' '))
    const body = request.mock.calls.find(([url]) => String(url).includes('/token'))?.[1]
      ?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(config.redirect)
    expect(body.has('client_secret')).toBe(false)
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    )
    expect(credential.accessToken).toBe('synthetic-access')
    expect(parseGrantedScopes(undefined)).toBeNull()
    expect(parseGrantedScopes('')).toEqual([])
    expect(parseGrantedScopes(`${READ} offline_access`)).toEqual([READ])
  })

  it.each(['state', 'denial', 'missing-code', 'cancel', 'browser'])(
    'fails closed on %s and closes the listener',
    async (kind) => {
      const controller = new AbortController()
      const request = vi.fn<typeof fetch>(async (url) =>
        String(url).includes('/.well-known/')
          ? new Response(JSON.stringify(oauthMetadata()))
          : reply(),
      )
      const client = new OAuthClient(
        config,
        store,
        async (url) => {
          if (kind === 'cancel') controller.abort()
          if (kind === 'browser') throw new Error('browser unavailable')
          if (kind === 'state' || kind === 'denial' || kind === 'missing-code') {
            await callback(url, (returned) => {
              if (kind === 'state') returned.searchParams.set('state', 'wrong')
              if (kind === 'denial') returned.searchParams.set('error', 'access_denied')
              if (kind === 'missing-code') returned.searchParams.delete('code')
            })
          }
        },
        request,
      )
      await expect(client.acquire({ signal: controller.signal })).rejects.toThrow()
      await expect(fetch(config.redirect)).rejects.toThrow()
      expect(await fs.readdir(directory)).toEqual([`${store.binding}.lock`])
    },
  )

  it('persists a rotated refresh token and keeps the previous one only when omitted', async () => {
    await seed()
    const request = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      const sent = options?.body as URLSearchParams
      expect(sent.get('refresh_token')).toBe('old-refresh')
      expect(sent.has('scope')).toBe(false)
      return reply({ refresh_token: 'rotated', scope: READ })
    })
    const credential = await new OAuthClient(
      config,
      store,
      async () => {
        throw new Error('no browser')
      },
      request,
    ).acquire()
    expect(credential).toMatchObject({
      accessToken: 'synthetic-access',
      refreshToken: 'rotated',
      grantedScopes: [READ],
    })
    await seed({ refreshToken: 'old-refresh' })
    request.mockImplementation(async (url) =>
      String(url).includes('/.well-known/')
        ? new Response(JSON.stringify(oauthMetadata()))
        : reply({ refresh_token: undefined }),
    )
    await new OAuthClient(
      config,
      store,
      async () => {
        throw new Error('no browser')
      },
      request,
    ).acquire()
    expect((await store.read())?.refreshToken).toBe('old-refresh')
  })

  it('opens exactly one consent after a rejected refresh and not after an uncertain failure', async () => {
    await seed()
    const browser = vi.fn(async (url: string) => {
      await callback(url)
    })
    const rejected = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      if (
        rejected.mock.calls.filter(([target]) => String(target).includes('/token')).length === 1
      ) {
        return new Response('denied', { status: 400 })
      }
      return reply()
    })
    await new OAuthClient(config, store, browser, rejected).acquire()
    expect(browser).toHaveBeenCalledOnce()

    await seed()
    const noBrowser = vi.fn(async () => {
      throw new Error('browser unavailable')
    })
    const network = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      throw new Error('synthetic-secret')
    })
    await expect(new OAuthClient(config, store, noBrowser, network).acquire()).rejects.toThrow(
      'exchange failed',
    )
    expect(noBrowser).not.toHaveBeenCalled()
    expect(await store.read()).toBeUndefined()
  })

  it('does not consume a refresh token when discovery fails', async () => {
    await seed({ refreshToken: 'REFRESH' })
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('SECRET')
    })
    const browser = vi.fn()
    const client = new OAuthClient(config, store, browser, request)
    await expect(client.acquire()).rejects.toThrow('OAuth metadata discovery failed')
    expect(browser).not.toHaveBeenCalled()
    expect((await store.read())?.refreshToken).toBe('REFRESH')
    expect(request.mock.calls.every(([url]) => !String(url).includes('/token'))).toBe(true)
  })

  it('serializes two stores so a rotating refresh token is not replayed', async () => {
    await seed()
    const request = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/.well-known/'))
        return new Response(JSON.stringify(oauthMetadata()))
      const old = (options?.body as URLSearchParams).get('refresh_token')
      return reply({ refresh_token: `${old}-next` })
    })
    const browser = async () => {
      throw new Error('no browser')
    }
    const [a, b] = await Promise.all([
      new OAuthClient(config, store, browser, request).acquire(),
      new OAuthClient(config, new OAuthStore(config, directory), browser, request).acquire(),
    ])
    expect(request.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1)
    expect(a.accessToken).toBe(b.accessToken)
  })
})

describe('authorization server metadata', () => {
  const host = 'https://example.com'
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  it('uses the RFC path and falls back to root only after 404', async () => {
    const rfc = vi.fn<typeof fetch>(async () => json(oauthMetadata()))
    expect(await discoverOAuthMetadata(host, rfc)).toEqual(oauthMetadata())
    expect(rfc).toHaveBeenCalledOnce()
    expect(rfc.mock.calls[0][0]).toBe(`${host}/.well-known/oauth-authorization-server/multipass`)
    expect(rfc.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
    const fallback = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json(oauthMetadata()))
    expect(await discoverOAuthMetadata(host, fallback)).toEqual(oauthMetadata())
    expect(String(fallback.mock.calls[1][0])).toBe(`${host}/.well-known/oauth-authorization-server`)
    const unavailable = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }))
    await expect(discoverOAuthMetadata(host, unavailable)).rejects.toThrow(
      'OAuth metadata discovery failed',
    )
    expect(unavailable).toHaveBeenCalledOnce()
  })
  it.each([
    { issuer: `${host}/other` },
    { authorization_endpoint: 'https://evil.example/authorize' },
    { token_endpoint: 'http://example.com/token' },
    { code_challenge_methods_supported: ['plain'] },
    { grant_types_supported: ['authorization_code'] },
    { grant_types_supported: ['refresh_token'] },
  ])('rejects unsafe metadata %j', async (change) => {
    const request = vi.fn<typeof fetch>(async () => json({ ...oauthMetadata(), ...change }))
    await expect(discoverOAuthMetadata(host, request)).rejects.toThrow(
      'OAuth metadata discovery failed',
    )
    expect(request).toHaveBeenCalledOnce()
  })
})

describe('registered configuration', () => {
  it('uses the registered client, callback and profile, and accepts scopes', () => {
    expect(authConfig('https://EXAMPLE.com')).toEqual({
      host: 'https://example.com',
      clientId: PALANTIR_MCP_CLIENT_ID,
      redirect: PALANTIR_MCP_REDIRECT,
      profile: 'default',
      scopes: authConfig('https://example.com').scopes,
    })
    expect(authConfig('https://example.com', `${READ} ${READ}`).scopes).toEqual([
      'offline_access',
      READ,
    ])
    for (const host of [
      'http://host',
      'https://host/path',
      'https://user:secret@host',
      'https://host?secret',
    ]) {
      expect(() => authConfig(host)).toThrow()
    }
  })
})
