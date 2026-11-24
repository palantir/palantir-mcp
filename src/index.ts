#!/usr/bin/env node

/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { selectRuntime } from './auth/arguments.js'
import { runAuth } from './auth/command.js'
import { runOAuthRuntime } from './auth/runtime.js'
import { parseArguments } from './command.js'
import { LegacyTokenProvider } from './legacyTokenProvider.js'
import {
  checkNodeVersion,
  checkNetworkConnectivity,
  checkPackageAvailability,
} from './preflightChecks.js'
import { buildNpmRegistryUrl } from './registry.js'
import { spawnMcp } from './spawn.js'

async function main() {
  if (process.argv[2] === 'auth') {
    await runAuth(process.argv)
    return
  }
  let selection: ReturnType<typeof selectRuntime>
  try {
    selection = selectRuntime(process.argv)
  } catch (error) {
    // Argument errors are local and never include supplied values.
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }
  if (selection.mode === 'oauth') {
    // Explicit OAuth never falls back to legacy tokens, cache, Git bootstrap or browser broker.
    await runOAuthRuntime(selection.config, selection.forwardedArgs)
    return
  }
  const argv = selection.argv
  const { foundryToken, foundryApiUrl } = parseArguments(argv)
  const npmRegistry: URL = buildNpmRegistryUrl(foundryApiUrl)

  let validatedFoundryToken: string

  try {
    checkNodeVersion()
    await checkNetworkConnectivity(foundryApiUrl)
    validatedFoundryToken = await new LegacyTokenProvider(foundryApiUrl, foundryToken).getToken()
    // important for child processes spawned later
    process.env.FOUNDRY_TOKEN = validatedFoundryToken

    await checkPackageAvailability(npmRegistry, validatedFoundryToken)
  } catch (error) {
    console.error(error) // TODO should this be a console.log to expose in Claude Code?
    process.exit(1)
  }

  spawnMcp({
    npmRegistry,
    foundryToken: validatedFoundryToken,
    args: argv.slice(2),
  })
}

main()
