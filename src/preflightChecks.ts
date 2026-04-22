/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import {
  InvalidAuthTokenError,
  NetworkError,
  NodeVersionError,
  NoTokenAvailableError,
  PackageFetchError,
} from './errors.js'
import { parseGitToken } from './utils/gitConfigParser.js'
import { loadCachedToken } from './utils/tokenCache.js'
import { TokenRefreshUtils } from './utils/tokenRefreshUtils.js'

export function checkNodeVersion(): void {
  const nodeVersion = process.versions.node
  const majorVersion = parseInt(nodeVersion.split('.')[0])
  if (majorVersion < 18) {
    throw new NodeVersionError(nodeVersion)
  }
}

export async function checkNetworkConnectivity(foundryApiUrl: URL): Promise<void> {
  try {
    const resp = await fetch(foundryApiUrl)
    if (!resp.ok) {
      throw new Error(`${foundryApiUrl} responded with unexpected status ${resp.status}`)
    }
  } catch (error) {
    throw new NetworkError(foundryApiUrl, error)
  }
}

/**
 * Tries to validate/refresh a single token via Multipass TTL check.
 * Returns the token (or a refreshed replacement) on success, undefined on failure.
 */
async function tryRefreshToken(foundryApiUrl: URL, token: string): Promise<string | undefined> {
  try {
    const newToken = await new TokenRefreshUtils(foundryApiUrl, token).refreshTokenIfExpired()
    return newToken ?? token
  } catch (error: unknown) {
    if (error instanceof InvalidAuthTokenError) {
      console.error(`[auth] Token invalid, trying next source: ${error.message}`)
      return undefined
    }
    throw error
  }
}

/**
 * Git token has very limited scope — only useful to bootstrap browser auth.
 */
async function bootstrapTokenFromGitConfig(foundryApiUrl: URL): Promise<string | undefined> {
  const gitToken = parseGitToken(process.cwd())
  if (!gitToken) {
    return undefined
  }
  try {
    const newToken = await new TokenRefreshUtils(foundryApiUrl, gitToken).refreshTokenIfExpired()
    return newToken || undefined
  } catch {
    return undefined
  }
}

/**
 * Validates a Foundry token, trying each available source in priority order:
 * cached token → CLI token → git token (bootstrap only).
 */
export async function validateFoundryToken(
  foundryApiUrl: URL,
  cliToken: string | undefined,
): Promise<string> {
  const cachedToken = loadCachedToken(foundryApiUrl.origin)

  if (cachedToken) {
    const result = await tryRefreshToken(foundryApiUrl, cachedToken)
    if (result) {
      return result
    }
  }

  if (cliToken && cliToken !== cachedToken) {
    const result = await tryRefreshToken(foundryApiUrl, cliToken)
    if (result) {
      return result
    }
  }

  const bootstrapped = await bootstrapTokenFromGitConfig(foundryApiUrl)
  if (bootstrapped) {
    return bootstrapped
  }

  throw new NoTokenAvailableError(foundryApiUrl.hostname)
}

export async function checkPackageAvailability(
  npmRegistry: URL,
  foundryToken: string,
): Promise<void> {
  const packageMetadataUrl = new URL(npmRegistry.toString())
  packageMetadataUrl.pathname += encodeURIComponent('@palantir/mcp')

  try {
    const requestOptions = {
      headers: { Authorization: `Bearer ${foundryToken}` },
    }
    const resp = await fetch(packageMetadataUrl, requestOptions)
    if (!resp.ok) {
      console.error(await resp.json())

      throw new Error(
        `Retrieving the Palantir MCP package responded with unexpected status ${resp.status}`,
      )
    }
  } catch (error) {
    throw new PackageFetchError(error)
  }
}
