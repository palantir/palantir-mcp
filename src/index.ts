#!/usr/bin/env node

/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { parseArguments } from './command.js'
import { runPreflightChecks } from './preflightChecks.js'
import { buildNpmRegistryUrl } from './registry.js'
import { spawnMcp } from './spawn.js'

async function main() {
  const { foundryToken, foundryApiUrl } = parseArguments(process.argv)
  const npmRegistry = buildNpmRegistryUrl(foundryApiUrl)

  try {
    await runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }

  spawnMcp({
    npmRegistry,
    foundryToken,
    args: process.argv.slice(2),
  })
}

main()
