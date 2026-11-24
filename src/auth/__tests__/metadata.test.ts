/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthClient } from '../client.js'
import { authConfig } from '../config.js'
import { discoverOAuthMetadata } from '../metadata.js'
import { OAuthStore } from '../store.js'
import { oauthMetadata } from './fixtures/oauthMetadata.js'

const host = 'https://example.com'
const rfc = `${host}/.well-known/oauth-authorization-server/multipass`
const root = `${host}/.well-known/oauth-authorization-server`
const directories: string[] = []
const json = (value: unknown) => new Response(JSON.stringify(value))
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('OAuth authorization server metadata', () => {
  it.each([false, true])(
    'discovers metadata (root fallback: %s), sharing concurrent and cached reads',
    async (fallback) => {
      const request = vi.fn<typeof fetch>().mockImplementation(async () => json(oauthMetadata()))
      if (fallback) request.mockResolvedValueOnce(new Response(null, { status: 404 }))
      const [first, second] = await Promise.all([
        discoverOAuthMetadata(host, request),
        discoverOAuthMetadata(host, request),
      ])
      expect(first).toEqual(oauthMetadata())
      expect(first).toBe(second)
      expect(await discoverOAuthMetadata(host, request)).toBe(first)
      expect(request.mock.calls.map(([url]) => url)).toEqual(fallback ? [rfc, root] : [rfc])
      expect(request.mock.calls[0][1]).toMatchObject({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
      await discoverOAuthMetadata('https://other.example', request).catch(() => undefined)
      expect(request).toHaveBeenCalledTimes(fallback ? 3 : 2)
    },
  )

  it.each([
    { change: { issuer: `${host}/other` }, error: 'issuer' },
    { change: { authorization_endpoint: 'https://evil.example/authorize' }, error: 'origin' },
    { change: { token_endpoint: 'https://evil.example/token' }, error: 'origin' },
    { change: { token_endpoint: 'http://example.com/token' }, error: 'HTTPS' },
    { change: { token_endpoint: 'https://user:secret@example.com/token' }, error: 'credentials' },
    { change: { token_endpoint: `${host}/token#fragment` }, error: 'fragments' },
    { change: { token_endpoint: 'not a URL' }, error: 'invalid response' },
    { change: { code_challenge_methods_supported: ['plain'] }, error: 'S256' },
    { change: { code_challenge_methods_supported: undefined }, error: 'invalid' },
    { change: { grant_types_supported: ['authorization_code'] }, error: 'refresh_token' },
    { change: { grant_types_supported: ['refresh_token'] }, error: 'authorization_code' },
    { change: { grant_types_supported: undefined }, error: 'invalid' },
  ])('rejects unsafe or unsupported metadata: $change', async ({ change, error }) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ ...oauthMetadata(), ...change }))
    await expect(discoverOAuthMetadata(host, request)).rejects.toThrow(error)
    expect(request).toHaveBeenCalledOnce()
  })

  it('sanitizes network failures and evicts failures for retry', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('SECRET'))
      .mockResolvedValueOnce(json(oauthMetadata()))
    await expect(discoverOAuthMetadata(host, request)).rejects.toThrow(
      'OAuth metadata discovery failed: network',
    )
    expect(await discoverOAuthMetadata(host, request)).toEqual(oauthMetadata())
  })

  it.each([302, 404, 500])('never falls back to fixed endpoints after HTTP %s', async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status }))
    await expect(discoverOAuthMetadata(host, request)).rejects.toThrow('metadata discovery failed')
    expect(request).toHaveBeenCalledTimes(status === 404 ? 2 : 1)
  })

  it.each(['fetch', 'body'])(
    'bounds stalled %s to 15 seconds even if abort is ignored',
    async (stage) => {
      vi.useFakeTimers()
      const request = vi.fn<typeof fetch>().mockImplementation(() =>
        stage === 'fetch'
          ? new Promise(() => {})
          : Promise.resolve({
              ok: true,
              json: () => new Promise(() => {}),
            } as unknown as Response),
      )
      const failed = expect(discoverOAuthMetadata(host, request)).rejects.toThrow('timeout')
      await vi.advanceTimersByTimeAsync(15_000)
      await failed
    },
  )
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-metadata-'))
  directories.push(directory)
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const config = authConfig({
    foundryApiUrl: host,
    oauthRedirect: `http://127.0.0.1:${port}/callback`,
  })
  const store = new OAuthStore(config, directory)
  return { config, store, directory }
}

describe('lazy discovery and offline access', () => {
  it.each([false, true])(
    'uses discovered endpoints and warns only if no refresh token is issued (%s)',
    async (issued) => {
      const { config, store, directory } = await fixture()
      const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
        init?.method === 'POST'
          ? json({
              access_token: 'ACCESS',
              refresh_token: issued ? 'REFRESH' : undefined,
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'palantir-mcp:read-metadata offline_access',
            })
          : json(oauthMetadata()),
      )
      const browser = vi.fn(async (url: string) => {
        const authorization = new URL(url)
        expect(authorization.origin + authorization.pathname).toBe(
          oauthMetadata().authorization_endpoint,
        )
        const callback = new URL(config.redirect)
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        callback.searchParams.set('code', 'CODE')
        await fetch(callback)
      })
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
      const client = new OAuthClient(config, store, browser, request)
      expect(await client.status()).toBeUndefined()
      expect(request).not.toHaveBeenCalled()
      await client.login()
      expect(Boolean((await client.status())?.refreshToken)).toBe(issued)
      expect(
        stderr.mock.calls
          .flat()
          .join('\n')
          .includes('offline access was requested but not granted'),
      ).toBe(!issued)
      expect(request.mock.calls[1]).toEqual([
        oauthMetadata().token_endpoint,
        expect.objectContaining({ method: 'POST', redirect: 'error' }),
      ])
      await new OAuthClient(config, store, browser, request).login()
      expect(request.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(1)
      const credential = JSON.parse(
        await fs.readFile(path.join(directory, `${store.binding}.json`), 'utf8'),
      )
      expect(credential).not.toHaveProperty('offlineAccess')
      expect(credential.grantedScopes).toEqual(['palantir-mcp:read-metadata'])
    },
  )

  it('fails login before browser launch and preserves rotating credentials on discovery failure', async () => {
    const { config, store } = await fixture()
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('SECRET'))
    const browser = vi.fn()
    const client = new OAuthClient(config, store, browser, request)
    await expect(client.login()).rejects.toThrow('OAuth metadata discovery failed')
    expect(browser).not.toHaveBeenCalled()
    await store.locked(() =>
      store.write({
        version: 1,
        binding: store.binding,
        requestedScopes: config.scopes,
        grantedScopes: null,
        accessToken: 'OLD',
        refreshToken: 'REFRESH',
        expiresAt: 0,
      }),
    )
    await expect(client.refresh()).rejects.toThrow('OAuth metadata discovery failed')
    expect((await store.read())?.refreshToken).toBe('REFRESH')
    await expect(client.acquire()).rejects.toThrow('OAuth metadata discovery failed')
    expect((await store.read())?.refreshToken).toBe('REFRESH')
    expect(request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
  })
})
