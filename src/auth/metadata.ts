/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { discardBody } from './response.js'

interface OAuthMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  code_challenge_methods_supported: string[]
  grant_types_supported: string[]
}

// Share pending and successful discovery across clients, isolating injected transports in tests.
const cache = new WeakMap<typeof fetch, Map<string, Promise<OAuthMetadata>>>()

export function discoverOAuthMetadata(
  host: string,
  request: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  let hosts = cache.get(request)
  if (!hosts) {
    hosts = new Map()
    cache.set(request, hosts)
  }
  let pending = hosts.get(host)
  if (!pending) {
    pending = discover(host, request).catch((error) => {
      hosts.delete(host)
      throw error
    })
    hosts.set(host, pending)
  }
  return pending
}

class MetadataError extends Error {}

async function discover(host: string, request: typeof fetch): Promise<OAuthMetadata> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  // Bound both fetch and body consumption, including transports that ignore abort.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Timeout')), { once: true })
  })
  try {
    const paths = [
      '/.well-known/oauth-authorization-server/multipass',
      '/.well-known/oauth-authorization-server',
    ]
    for (const path of paths) {
      const response = await Promise.race([
        request(`${host}${path}`, { signal: controller.signal, redirect: 'error' }),
        aborted,
      ])
      if (!response.ok) {
        discardBody(response)
        // Only an absent RFC 8414 route permits trying root metadata; never use fixed endpoints.
        if (response.status === 404 && path === paths[0]) continue
        throw new MetadataError('OAuth metadata discovery failed: authorization server unavailable')
      }
      const value = (await Promise.race([response.json(), aborted])) as Record<
        string,
        unknown
      > | null
      if (
        !value ||
        !['issuer', 'authorization_endpoint', 'token_endpoint'].every(
          (key) => typeof value[key] === 'string',
        ) ||
        !['code_challenge_methods_supported', 'grant_types_supported'].every(
          (key) =>
            Array.isArray(value[key]) &&
            value[key].every((entry: unknown) => typeof entry === 'string'),
        )
      )
        throw new MetadataError(
          'OAuth metadata discovery failed: invalid authorization server metadata',
        )
      const metadata = value as unknown as OAuthMetadata
      if (metadata.issuer !== `${host}/multipass`)
        throw new MetadataError(
          'OAuth metadata discovery failed: issuer does not match the configured Multipass issuer',
        )
      for (const value of [metadata.authorization_endpoint, metadata.token_endpoint]) {
        const endpoint = new URL(value)
        if (
          endpoint.protocol !== 'https:' ||
          endpoint.origin !== new URL(host).origin ||
          endpoint.username ||
          endpoint.password ||
          endpoint.hash
        ) {
          throw new MetadataError(
            'OAuth metadata discovery failed: endpoints must use HTTPS on the configured Foundry origin without credentials or fragments',
          )
        }
      }
      if (!metadata.code_challenge_methods_supported.includes('S256'))
        throw new MetadataError(
          'OAuth metadata discovery failed: server must support S256 code challenges',
        )
      if (
        !['authorization_code', 'refresh_token'].every((grant) =>
          metadata.grant_types_supported.includes(grant),
        )
      )
        throw new MetadataError(
          'OAuth metadata discovery failed: server must support authorization_code and refresh_token grants',
        )
      return metadata
    }
    throw new MetadataError(
      'OAuth metadata discovery failed: authorization server metadata not found',
    )
  } catch (error) {
    if (error instanceof MetadataError) throw error
    throw new Error(
      'OAuth metadata discovery failed: network, timeout or invalid response; check connectivity and retry login',
    )
  } finally {
    clearTimeout(timer)
  }
}
