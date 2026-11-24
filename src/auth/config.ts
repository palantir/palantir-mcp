/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Public PKCE client defaults; no client secret is used. */
export const PALANTIR_MCP_CLIENT_ID = 'e9036da0035845c988db3a6536f08a42'
export const PALANTIR_MCP_REDIRECT = 'http://127.0.0.1:49152/oauth2redirect/palantir-mcp'

/** Special OAuth scope requesting a refresh token. It is never an operation grant. */
export const OFFLINE_ACCESS = 'offline_access'
export const TOOL_PERMISSION_GROUP_NAMES = [
  'palantir-mcp:read-metadata',
  'palantir-mcp:write-metadata',
  'palantir-mcp:read-data',
  'palantir-mcp:write-data',
  'palantir-mcp:execute',
] as const
export const DEFAULT_OAUTH_SCOPES = TOOL_PERMISSION_GROUP_NAMES.join(' ')

/**
 * OAuth credential configuration. `host`, `clientId`, `profile`, `scopes` and `redirect` form the
 * shared v1 credential binding.
 */
export interface OAuthConfig {
  host: string
  clientId: string
  redirect: string
  profile: string
  /** Requested scopes: sorted, unique and always including offline_access. */
  scopes: string[]
}

const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+$/

export function parseScopes(value: string | undefined): string[] {
  const scopes = (value ?? '').split(/\s+/).filter(Boolean)
  if (scopes.some((scope) => !SCOPE.test(scope))) throw new Error('Invalid OAuth scope')
  return [...new Set(scopes)].sort()
}

/** Registered client, callback and profile. Only the host and requested scopes vary. */
export function authConfig(foundryApiUrl: string, oauthScopes?: string): OAuthConfig {
  let host: URL
  try {
    host = new URL(foundryApiUrl)
  } catch {
    throw new Error('Invalid OAuth host')
  }
  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.pathname !== '/' ||
    host.search ||
    host.hash
  ) {
    throw new Error(
      'OAuth host must be an HTTPS origin without credentials, path, query or fragment',
    )
  }
  return {
    host: host.origin,
    clientId: PALANTIR_MCP_CLIENT_ID,
    redirect: PALANTIR_MCP_REDIRECT,
    profile: 'default',
    scopes: parseScopes(`${oauthScopes ?? DEFAULT_OAUTH_SCOPES} ${OFFLINE_ACCESS}`),
  }
}
