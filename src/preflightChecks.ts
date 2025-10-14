/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createPlatformClient } from '@osdk/client'
import { Users } from '@osdk/foundry.admin'

import {
  AuthenticationError,
  McpError,
  NetworkError,
  NodeVersionError,
  PackageFetchError,
} from './errors.js'

export async function runPreflightChecks(
  foundryApiUrl: URL,
  foundryToken: string,
  npmRegistry: URL,
): Promise<void> {
  checkNodeVersion()
  await checkNetworkConnectivity(foundryApiUrl)
  await validateFoundryToken(foundryApiUrl, foundryToken)
  await checkPackageAvailability(npmRegistry, foundryToken)
}

function checkNodeVersion(): void {
  const nodeVersion = process.versions.node
  const majorVersion = parseInt(nodeVersion.split('.')[0])

  if (majorVersion < 18) {
    throw new NodeVersionError(nodeVersion)
  }
}

async function checkNetworkConnectivity(foundryApiUrl: URL): Promise<void> {
  try {
    const resp = await fetch(foundryApiUrl)
    if (!resp.ok) {
      throw new Error(`${foundryApiUrl} responded with unexpected status ${resp.status}`)
    }
  } catch (error) {
    throw new NetworkError(foundryApiUrl, error)
  }
}

async function validateFoundryToken(foundryApiUrl: URL, foundryToken: string): Promise<void> {
  const platformClient = createPlatformClient(foundryApiUrl.toString(), () =>
    Promise.resolve(foundryToken),
  )

  try {
    await Users.getCurrent(platformClient)
  } catch (error: any) {
    if (error.cause?.statusCode === 401) {
      throw new AuthenticationError(foundryApiUrl)
    }
    throw new McpError(
      `An unexpected error occurred when trying to connect to the Foundry API`,
      error,
    )
  }
}

async function checkPackageAvailability(npmRegistry: URL, foundryToken: string): Promise<void> {
  const packageMetadataUrl = new URL(npmRegistry.toString())
  packageMetadataUrl.pathname += encodeURIComponent('@palantir/mcp')

  try {
    const resp = await fetch(packageMetadataUrl, {
      headers: { Authorization: `Bearer ${foundryToken}` },
    })
    if (!resp.ok) {
      throw new Error(
        `Retrieving the Palantir MCP package responded with unexpected status ${resp.status}`,
      )
    }
  } catch (error) {
    throw new PackageFetchError(error)
  }
}
