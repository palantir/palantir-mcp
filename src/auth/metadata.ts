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

const failed = () => new Error('OAuth metadata discovery failed')

/** RFC 8414 discovery. Root metadata is tried only after a 404 on the Multipass path. */
export async function discoverOAuthMetadata(
  host: string,
  request: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  const signal = AbortSignal.timeout(15_000)
  const paths = [
    '/.well-known/oauth-authorization-server/multipass',
    '/.well-known/oauth-authorization-server',
  ]
  try {
    for (const path of paths) {
      const response = await request(`${host}${path}`, { signal, redirect: 'error' })
      if (!response.ok) {
        discardBody(response)
        if (response.status === 404 && path === paths[0]) continue
        throw failed()
      }
      const value = (await response.json()) as Record<string, unknown> | null
      if (!isMetadata(value)) throw failed()
      const metadata = value as unknown as OAuthMetadata
      if (metadata.issuer !== `${host}/multipass`) throw failed()
      for (const endpointValue of [metadata.authorization_endpoint, metadata.token_endpoint]) {
        let endpoint: URL
        try {
          endpoint = new URL(endpointValue)
        } catch {
          throw failed()
        }
        if (
          endpoint.protocol !== 'https:' ||
          endpoint.origin !== new URL(host).origin ||
          endpoint.username ||
          endpoint.password ||
          endpoint.hash
        ) {
          throw failed()
        }
      }
      if (!metadata.code_challenge_methods_supported.includes('S256')) throw failed()
      if (
        !['authorization_code', 'refresh_token'].every((grant) =>
          metadata.grant_types_supported.includes(grant),
        )
      ) {
        throw failed()
      }
      return metadata
    }
    throw failed()
  } catch (error) {
    if (error instanceof Error && error.message === 'OAuth metadata discovery failed') throw error
    throw failed()
  }
}

function isMetadata(value: Record<string, unknown> | null): boolean {
  if (!value) return false
  if (
    !['issuer', 'authorization_endpoint', 'token_endpoint'].every(
      (key) => typeof value[key] === 'string',
    )
  ) {
    return false
  }
  return ['code_challenge_methods_supported', 'grant_types_supported'].every(
    (key) =>
      Array.isArray(value[key]) && value[key].every((entry: unknown) => typeof entry === 'string'),
  )
}
