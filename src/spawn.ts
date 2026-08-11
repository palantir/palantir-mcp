/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'
import { constants } from 'os'
import { McpLaunchError } from './errors.js'

export interface SpawnOptions {
  npmRegistry: URL
  foundryToken: string
  args: string[]
}

/**
 * Translates the child's termination into an exit code for this process. A
 * signal death is reported as 128 + signal number, matching shell convention.
 */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code
  }

  const signalNumber = signal === null ? undefined : constants.signals[signal]
  return signalNumber === undefined ? 1 : 128 + signalNumber
}

export function spawnMcp({ npmRegistry, foundryToken, args }: SpawnOptions): void {
  const authTokenEnvVar = `NPM_CONFIG_//${npmRegistry.host + npmRegistry.pathname}:_authToken`

  const isWindows = process.platform === 'win32'
  const child = spawn('npx', ['-y', '@palantir/mcp@latest', ...args], {
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      NPM_CONFIG_REGISTRY: npmRegistry.toString(),
      [authTokenEnvVar]: foundryToken,
    },
  })

  // An MCP client treats this process as the server, so its exit status has to
  // mirror the child's. Without this the wrapper reports success even when the
  // server crashed, and a failed spawn surfaces as an unhandled 'error' event.
  child.on('error', (error) => {
    console.error(new McpLaunchError(error))
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    process.exit(exitCodeFor(code, signal))
  })

  process.on('SIGINT', () => {
    child.kill('SIGINT')
  })

  process.on('SIGTERM', () => {
    child.kill('SIGTERM')
  })
}
