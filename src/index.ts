#!/usr/bin/env node

/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { selectRuntime } from './auth/arguments.js'
import { runOAuthRuntime } from './auth/runtime.js'
import { parseArguments } from './command.js'
import {
  checkNetworkConnectivity,
  checkNodeVersion,
  checkPackageAvailability,
  validateFoundryToken,
} from './preflightChecks.js'
import { buildNpmRegistryUrl } from './registry.js'
import { spawnMcp } from './spawn.js'

export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv[2] === 'auth') {
    console.error(
      'This launcher does not provide auth commands. Start with --auth=oauth to sign in, or use token authentication.',
    )
    process.exitCode = 1
    return
  }
  let selection: ReturnType<typeof selectRuntime>
  try {
    selection = selectRuntime(argv)
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }
  if (selection.mode === 'oauth') {
    await runOAuthRuntime(selection.config, selection.forwardedArgs)
    return
  }
  const { foundryToken, foundryApiUrl } = parseArguments(selection.argv)
  const npmRegistry: URL = buildNpmRegistryUrl(foundryApiUrl)
  let validatedFoundryToken: string
  try {
    checkNodeVersion()
    await checkNetworkConnectivity(foundryApiUrl)
    validatedFoundryToken = await validateFoundryToken(foundryApiUrl, foundryToken)
    process.env.FOUNDRY_TOKEN = validatedFoundryToken
    await checkPackageAvailability(npmRegistry, validatedFoundryToken)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
  spawnMcp({
    npmRegistry,
    foundryToken: validatedFoundryToken,
    args: selection.argv.slice(2),
  })
}

// Tests that import this module set the variable first. A built process still starts normally.
if (process.env.PALANTIR_MCP_NO_AUTOSTART !== '1') {
  void main()
}
