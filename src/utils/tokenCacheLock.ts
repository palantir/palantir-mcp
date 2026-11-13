/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import lockfile from 'proper-lockfile'

/**
 * Shared protocol with the other MCP package: lock the entire cache, not a host,
 * since updating one host is a read/modify/write of the same JSON document.
 * Never continue with browser authentication if acquiring the lock fails.
 */
export async function withTokenCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  const directory = path.join(os.homedir(), '.palantir')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(path.join(directory, 'mcp-config.json'), {
    realpath: false,
    stale: 120_000,
    update: 10_000,
    retries: { retries: 720, factor: 1, minTimeout: 250, maxTimeout: 250 },
  })
  try {
    return await operation()
  } finally {
    await release()
  }
}
