/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { authConfig, OAuthConfig } from './config.js'

export type AuthMode = 'legacy' | 'oauth'

export type RuntimeSelection =
  | { mode: 'legacy'; argv: string[] }
  | { mode: 'oauth'; config: OAuthConfig; forwardedArgs: string[] }

/** The only wrapper-owned OAuth value. Client, callback and profile are registered constants. */
const OAUTH_SCOPES = '--oauth-scopes'

export class RuntimeArgumentError extends Error {}

/** Split `--name=value` / `--name value`; never include values in errors. */
function optionName(arg: string): string {
  const index = arg.indexOf('=')
  return index < 0 ? arg : arg.slice(0, index)
}

function isOAuthOption(name: string): boolean {
  return name === '--oauth' || name.startsWith('--oauth-')
}

/**
 * Select the startup credential provider. `--auth=legacy` is the default; `--auth=oauth` never
 * falls back to legacy tokens, cache, Git bootstrap or the project-selection browser flow.
 *
 * Legacy mode removes only the explicit `--auth` selector and forwards all other argv unchanged.
 * OAuth mode consumes `--oauth-scopes` and `--foundry-api-url`, rejects `--foundry-token` and
 * other `--oauth-*` flags, and forwards the remaining arguments to the private package.
 * An inherited `FOUNDRY_TOKEN` environment variable is ignored in OAuth mode.
 */
export function selectRuntime(argv: string[]): RuntimeSelection {
  const legacyArgv = argv.slice(0, 2)
  const forwarded: string[] = []
  const values: Record<string, string> = {}
  let mode: AuthMode | undefined
  let foundryToken = false
  let oauthOptionSeen = false
  let apiUrlCount = 0
  const take = (i: number, arg: string): [string | undefined, number] => {
    const index = arg.indexOf('=')
    if (index >= 0) return [arg.slice(index + 1), i]
    return i + 1 < argv.length ? [argv[i + 1], i + 1] : [undefined, i]
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const name = optionName(arg)
    if (name === '--foundry-token' || name === '--foundry-api-url') {
      // Values may resemble flags; keep them opaque.
      const [value, next] = take(i, arg)
      legacyArgv.push(...argv.slice(i, next + 1))
      if (name === '--foundry-token') foundryToken = true
      else {
        // Legacy keeps Commander's own handling; OAuth validates these after mode selection.
        apiUrlCount++
        values.foundryApiUrl = value as string
      }
      i = next
    } else if (name === '--auth') {
      const [value, next] = take(i, arg)
      if (mode !== undefined) throw new RuntimeArgumentError('Specify --auth only once')
      if (value !== 'legacy' && value !== 'oauth')
        throw new RuntimeArgumentError('Expected --auth=legacy or --auth=oauth')
      mode = value
      i = next
    } else if (name === OAUTH_SCOPES) {
      const [value, next] = take(i, arg)
      if (value === undefined) throw new RuntimeArgumentError(`${name} needs a value`)
      if (values.oauthScopes !== undefined)
        throw new RuntimeArgumentError(`Specify ${name} only once`)
      values.oauthScopes = value
      oauthOptionSeen = true
      i = next
    } else if (isOAuthOption(name)) {
      throw new RuntimeArgumentError(
        `Unsupported OAuth option ${name}; --auth=oauth accepts --oauth-scopes only`,
      )
    } else {
      legacyArgv.push(arg)
      forwarded.push(arg)
    }
  }
  if (mode !== 'oauth') {
    if (oauthOptionSeen)
      throw new RuntimeArgumentError(
        'OAuth options require --auth=oauth; legacy authentication was not attempted',
      )
    return { mode: 'legacy', argv: legacyArgv }
  }
  if (foundryToken)
    throw new RuntimeArgumentError(
      '--auth=oauth conflicts with --foundry-token; remove the token or use --auth=legacy',
    )
  if (apiUrlCount > 1) throw new RuntimeArgumentError('Specify --foundry-api-url only once')
  if (values.foundryApiUrl === undefined)
    throw new RuntimeArgumentError('--auth=oauth requires --foundry-api-url')
  let config: OAuthConfig
  try {
    config = authConfig(values.foundryApiUrl, values.oauthScopes)
  } catch (error) {
    throw new RuntimeArgumentError((error as Error).message)
  }
  return { mode: 'oauth', config, forwardedArgs: forwarded }
}

/**
 * Nonsecret v1 handoff argv for the private runtime. The private package reads and refreshes the
 * same protected credential state; no token or refresh credential is placed in argv/environment
 * for it. The registered client, callback, profile and requested scopes are passed explicitly so
 * both sides use the same binding. Explicit private start subcommands are required so the default
 * legacy path is not used.
 */
export function privateRuntimeArgs(config: OAuthConfig, forwardedArgs: string[]): string[] {
  return [
    'start',
    'local-development',
    '--auth=oauth',
    '--foundry-api-url',
    config.host,
    '--oauth-client-id',
    config.clientId,
    '--oauth-redirect',
    config.redirect,
    '--oauth-profile',
    config.profile,
    '--oauth-scopes',
    config.scopes.join(' '),
    ...forwardedArgs,
  ]
}
