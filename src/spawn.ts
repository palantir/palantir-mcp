/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'

export interface SpawnOptions {
  npmRegistry: URL
  foundryToken: string
  args: string[]
}

const PALANTIR_MCP_PREFIX = '@palantir/mcp@'

/** Resolved package spec for npx (default @palantir/mcp@latest). Exposed for tests. */
export function resolvePalantirMcpPackageSpec(): string {
  const override = process.env.PALANTIR_MCP_PACKAGE?.trim()
  if (!override) {
    return `${PALANTIR_MCP_PREFIX}latest`
  }
  if (!override.startsWith(PALANTIR_MCP_PREFIX)) {
    throw new Error(
      `PALANTIR_MCP_PACKAGE must start with ${PALANTIR_MCP_PREFIX} (e.g. ${PALANTIR_MCP_PREFIX}0.305.0)`,
    )
  }
  const version = override.slice(PALANTIR_MCP_PREFIX.length)
  if (!version || !/^[\w.+-]+$/.test(version)) {
    throw new Error(
      `PALANTIR_MCP_PACKAGE version segment after ${PALANTIR_MCP_PREFIX} must be non-empty and npm-version-safe`,
    )
  }
  return override
}

export function spawnMcp({ npmRegistry, foundryToken, args }: SpawnOptions): void {
  const authTokenEnvVar = `NPM_CONFIG_//${npmRegistry.host + npmRegistry.pathname}:_authToken`
  const packageSpec = resolvePalantirMcpPackageSpec()

  const isWindows = process.platform === 'win32'
  const child = spawn('npx', ['-y', packageSpec, ...args], {
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      NPM_CONFIG_REGISTRY: npmRegistry.toString(),
      [authTokenEnvVar]: foundryToken,
    },
  })

  process.on('SIGINT', () => {
    child.kill('SIGINT')
  })

  process.on('SIGTERM', () => {
    child.kill('SIGTERM')
  })
}
