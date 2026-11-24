/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Command, CommanderError, Option } from 'commander'
import { OAuthClient } from './client.js'
import { AuthOptions, authConfig, DEFAULT_OAUTH_SCOPES, OFFLINE_ACCESS } from './config.js'
import { Credential } from './store.js'

class AuthConfigError extends Error {}

function statusText(credential: Credential | undefined): string {
  if (!credential)
    return 'No OAuth credential for this configuration. Startup will open browser authorization automatically.\nOffline access: not granted (no refresh token)'
  const remaining = Math.round((credential.expiresAt - Date.now()) / 1000)
  const requested = credential.requestedScopes.filter((scope) => scope !== OFFLINE_ACCESS)
  const granted =
    credential.grantedScopes === null
      ? 'not reported by the token endpoint'
      : credential.grantedScopes.join(' ') || '(none)'
  return [
    `Access token: ${remaining > 0 ? `expires in ${remaining}s` : 'expired'}`,
    `Refresh credential: ${credential.refreshToken ? 'present' : 'absent'}`,
    `Offline access: ${credential.refreshToken ? 'granted' : 'not granted (no refresh token)'}`,
    `Requested operation scopes: ${requested.join(' ') || '(none)'}`,
    `Reported granted scopes: ${granted}`,
  ].join('\n')
}

/** This command is dispatched before every legacy preflight, credential lookup and private download. */
export async function runAuth(argv: string[]): Promise<void> {
  const command = new Command('palantir-mcp auth')
    .description('Public OAuth credential management; does not download or start the MCP server')
    .exitOverride()
    // Commander may include argument values in errors. Never print supplied credential-like input.
    .configureOutput({ writeErr: () => {} })
  for (const operation of ['login', 'refresh', 'logout', 'status'] as const) {
    command
      .command(operation)
      .requiredOption('--foundry-api-url <origin>', 'HTTPS Foundry origin')
      .addOption(new Option('--auth <mode>', 'Credential provider').choices(['oauth', 'legacy']))
      .option('--oauth-client-id <id>', 'Override the Palantir MCP public client ID')
      .option('--oauth-redirect <uri>', 'Override the registered Palantir MCP loopback callback')
      .option(
        '--oauth-scopes <scopes>',
        'Space-separated requested operation scopes; offline_access is added',
        DEFAULT_OAUTH_SCOPES,
      )
      .option('--oauth-profile <profile>', 'Isolated credential profile', 'default')
      .action(async (options: AuthOptions & { auth?: 'oauth' | 'legacy' }) => {
        let client: OAuthClient
        try {
          if (options.auth === 'legacy')
            throw new Error('OAuth credential commands do not apply to --auth=legacy')
          client = new OAuthClient(authConfig(options))
        } catch (error) {
          // Configuration messages are local and never contain supplied values.
          throw new AuthConfigError((error as Error).message)
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        process.once('SIGINT', abort)
        process.once('SIGTERM', abort)
        try {
          if (operation === 'status') {
            console.error(statusText(await client.status(controller.signal)))
          } else if (operation === 'logout') {
            await client.logout(controller.signal)
            console.error('Local OAuth credentials removed. Server-side tokens are not revoked.')
          } else {
            const credential = await client[operation](controller.signal)
            console.error(`OAuth credentials saved.\n${statusText(credential)}`)
          }
        } finally {
          process.removeListener('SIGINT', abort)
          process.removeListener('SIGTERM', abort)
        }
      })
  }
  try {
    await command.parseAsync(argv.slice(3), { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return
      console.error('Invalid auth command or options; see palantir-mcp auth --help')
    } else if (error instanceof AuthConfigError) {
      console.error(error.message)
    } else {
      // All lifecycle errors are local sanitized messages; never print raw network/storage errors.
      console.error(
        'OAuth command failed. Check configuration, client installation, private storage and callback availability. Startup automatically authorizes when credentials need renewal.',
      )
    }
    process.exitCode = 1
  }
}
