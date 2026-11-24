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

/** Commander-style option names shared by `auth <command>` and `--auth=oauth` startup. */
export interface AuthOptions {
  foundryApiUrl: string
  oauthClientId?: string
  oauthRedirect?: string
  oauthProfile?: string
  oauthScopes?: string
}

const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+$/

export function parseScopes(value: string | undefined): string[] {
  const scopes = (value ?? '').split(/\s+/).filter(Boolean)
  if (scopes.some((scope) => !SCOPE.test(scope))) throw new Error('Invalid OAuth scope')
  return [...new Set(scopes)].sort()
}

export function authConfig(options: AuthOptions): OAuthConfig {
  let host: URL
  let redirect: URL
  try {
    host = new URL(options.foundryApiUrl)
    redirect = new URL(options.oauthRedirect ?? PALANTIR_MCP_REDIRECT)
  } catch {
    throw new Error('Invalid OAuth host or callback URL')
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
  if (
    redirect.protocol !== 'http:' ||
    redirect.hostname !== '127.0.0.1' ||
    !redirect.port ||
    Number(redirect.port) === 0 ||
    redirect.pathname === '/' ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error(
      'OAuth redirect must be an HTTP 127.0.0.1 callback with a nonzero port and path',
    )
  }
  const clientId = options.oauthClientId ?? PALANTIR_MCP_CLIENT_ID
  if (!clientId || /\s/.test(clientId)) {
    throw new Error('Specify an approved --oauth-client-id')
  }
  const profile = options.oauthProfile ?? 'default'
  if (!profile.trim()) throw new Error('OAuth profile must not be empty')
  const scopes = parseScopes(`${options.oauthScopes ?? DEFAULT_OAUTH_SCOPES} ${OFFLINE_ACCESS}`)
  return {
    host: host.origin,
    clientId,
    redirect: redirect.href,
    profile,
    scopes,
  }
}
