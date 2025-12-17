#!/usr/bin/env node

/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { parseArguments } from './command.js'
import {
  checkNodeVersion,
  checkNetworkConnectivity,
  validateFoundryToken,
  checkPackageAvailability,
} from './preflightChecks.js'
import { buildNpmRegistryUrl } from './registry.js'
import { spawnMcp } from './spawn.js'
import { getPackageVersion } from './utils/packageInfo.js'

async function main() {
  const { foundryToken, foundryApiUrl } = parseArguments(process.argv)
  const npmRegistry: URL = buildNpmRegistryUrl(foundryApiUrl)

  console.log('package verson:', getPackageVersion())

  let validatedFoundryToken: string

  try {
    checkNodeVersion()
    console.debug('Node.js version is sufficient.')
    await checkNetworkConnectivity(foundryApiUrl)
    console.debug('Network connectivity to Foundry API is OK.')
    validatedFoundryToken = await validateFoundryToken(foundryApiUrl, foundryToken)
    console.debug('Foundry token is valid.', validatedFoundryToken)
    // important for child processes spawned later
    process.env.FOUNDRY_TOKEN = validatedFoundryToken

    await checkPackageAvailability(npmRegistry, validatedFoundryToken)
    console.debug('Package @palantir/mcp is available in the registry.')
  } catch (error) {
    console.error(error) // TODO should this be a console.log to expose in Claude Code?
    process.exit(1)
  }

  spawnMcp({
    npmRegistry,
    foundryToken: validatedFoundryToken,
    args: process.argv.slice(2),
  })
}

main()
