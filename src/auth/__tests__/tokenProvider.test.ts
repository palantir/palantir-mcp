/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createServer, Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthClient } from '../client.js'
import { authConfig } from '../config.js'
import { Credential } from '../store.js'
import { OAuthTokenProvider } from '../tokenProvider.js'

const config = authConfig({ foundryApiUrl: 'https://example.com' })
const credential: Credential = {
  version: 1,
  binding: 'fixture',
  accessToken: 'old',
  refreshToken: 'refresh',
  expiresAt: 4102444800000,
  requestedScopes: config.scopes,
  grantedScopes: [],
}
const setup = () => {
  const client = new OAuthClient(config)
  const acquire = vi
    .spyOn(client, 'acquire')
    .mockResolvedValue({ ...credential, accessToken: 'new' })
  const request = vi.fn<typeof fetch>()
  return { client, acquire, request, provider: new OAuthTokenProvider(client, request, credential) }
}
afterEach(() => vi.restoreAllMocks())

describe('OAuth token provider fetch', () => {
  it.each([
    { Authorization: 'Custom caller' },
    new Headers({ authorization: 'Custom caller' }),
    [['authorization', 'Custom caller']] as [string, string][],
  ])('does not replace or refresh caller authorization: %j', async (headers) => {
    const { provider, request, acquire } = setup()
    request.mockResolvedValue(new Response('', { status: 401 }))
    const init = { headers }
    expect((await provider.fetch(config.host, init)).status).toBe(401)
    expect(request).toHaveBeenCalledExactlyOnceWith(config.host, init)
    expect(acquire).not.toHaveBeenCalled()
  })

  it('preserves Request authorization and respects init header precedence', async () => {
    const { provider, request, acquire } = setup()
    request.mockImplementation(async () => new Response('ok'))
    const input = new Request(config.host, { headers: { Authorization: 'Custom request' } })
    await provider.fetch(input)
    expect(request).toHaveBeenLastCalledWith(input, undefined)
    await provider.fetch(input, { headers: { Authorization: 'Custom override' } })
    expect(new Headers(request.mock.lastCall?.[1]?.headers).get('Authorization')).toBe(
      'Custom override',
    )
    expect(acquire).not.toHaveBeenCalled()
  })

  it.each([200, 403, 429, 500])('does not refresh after %s', async (status) => {
    const { provider, request, acquire } = setup()
    request.mockResolvedValue(new Response('', { status }))
    expect((await provider.fetch(config.host)).status).toBe(status)
    expect(acquire).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][1]?.redirect).toBeUndefined()
  })

  it('refreshes only its own token on 401 and retries once, including a Request body', async () => {
    const { provider, request, acquire } = setup()
    const observed: Array<{ token: string | null; body: string }> = []
    request.mockImplementation(async (input, init) => {
      const req = new Request(input, init)
      observed.push({ token: req.headers.get('Authorization'), body: await req.text() })
      return new Response('', { status: 401 })
    })
    const input = new Request(config.host, { method: 'POST', body: 'payload' })
    expect((await provider.fetch(input)).status).toBe(401)
    expect(observed).toEqual([
      { token: 'Bearer old', body: 'payload' },
      { token: 'Bearer new', body: 'payload' },
    ])
    expect(acquire).toHaveBeenCalledExactlyOnceWith({
      rejectedAccessToken: 'old',
      signal: input.signal,
    })
  })

  it('lazily acquires on first use and refuses other origins before acquisition or fetch', async () => {
    const { client, acquire, request } = setup()
    const provider = new OAuthTokenProvider(client, request)
    request.mockResolvedValue(new Response('ok'))
    await expect(provider.fetch('https://other.example')).rejects.toThrow('origin')
    expect(acquire).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    await provider.fetch(config.host)
    expect(acquire).toHaveBeenCalledOnce()
    expect(new Headers(request.mock.lastCall?.[1]?.headers).get('Authorization')).toBe('Bearer new')
  })

  it('propagates cancellation before sending a token', async () => {
    const { provider, request, acquire } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(provider.fetch(config.host, { signal: controller.signal })).rejects.toThrow()
    expect(acquire).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('standard fetch follows redirects without forwarding OAuth across origins', async () => {
    const seen: Array<string | undefined> = []
    const destination = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.end('ok')
    })
    const listen = (server: Server) =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
        }),
      )
    const close = (server: Server) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    const destinationUrl = await listen(destination)
    const origin = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(302, { Location: destinationUrl }).end()
    })
    try {
      // HTTP is only a loopback test transport; authConfig rejects it for real profiles.
      const host = await listen(origin)
      const client = new OAuthClient({ ...config, host })
      const provider = new OAuthTokenProvider(client, fetch, credential)
      expect((await provider.fetch(host)).status).toBe(200)
      expect(seen).toEqual(['Bearer old', undefined])
    } finally {
      await close(origin)
      await close(destination)
    }
  })
})
