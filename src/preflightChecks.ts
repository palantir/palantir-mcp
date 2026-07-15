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
 * Git token has very limited scope — only useful to bootstrap browser auth.
 */
async function bootstrapTokenFromGitConfig(foundryApiUrl: URL): Promise<string | undefined> {
  const gitToken = parseGitToken(process.cwd())
  if (!gitToken) {
    return undefined
  }
  try {
    return await new TokenRefreshUtils(foundryApiUrl, gitToken).forceRefreshToken()
  } catch {
    return undefined
  }
}

/**
 * Validates a Foundry token, preferring any token that is already valid before
 * ever initiating an interactive refresh. If the cache is expired but the
 * provided token is valid, the latter is used.
 *
 * Resolution order:
 *   1. Any already-valid token (cached, then CLI).
 *   2. Interactive refresh of an expired token (cached, then CLI).
 *   3. Git token bootstrap (browser auth).
 */
export async function validateFoundryToken(
  foundryApiUrl: URL,
  cliToken: string | undefined,
): Promise<string> {
  const cachedToken = loadCachedToken(foundryApiUrl.origin)
  const candidates = [...new Set([cachedToken, cliToken].filter((t) => t !== undefined))]

  // Valid-but-expired tokens, eligible for interactive refresh.
  const refreshable: string[] = []

  // 1. Prefer any already-valid token. isExpired() never opens a browser, so a
  //    stale cached token can no longer trigger auth ahead of a valid CLI/env token.
  for (const token of candidates) {
    try {
      if (await new TokenRefreshUtils(foundryApiUrl, token).isExpired()) {
        refreshable.push(token)
      } else {
        return token
      }
    } catch (error: unknown) {
      // Token is not valid for this environment
      if (error instanceof InvalidAuthTokenError) {
        console.error(error.message)
        continue
      }
      throw error
    }
  }

  // 2. Nothing is currently valid - interactively refresh an expired token.
  for (const token of refreshable) {
    try {
      return await new TokenRefreshUtils(foundryApiUrl, token).forceRefreshToken()
    } catch {
      // Browser auth failed or timed out — try the next candidate.
    }
  }

  // 3. Fall back to bootstrapping from the git token.
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
