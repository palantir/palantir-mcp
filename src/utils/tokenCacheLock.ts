/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { setTimeout as delay } from 'timers/promises'
import { tryLock } from 'fs-native-extensions'

/**
 * Shared local-filesystem protocol with the other MCP package.
 * This file is permanent: NEVER unlink/replace it, including during cleanup.
 * The kernel holds ownership across suspension and releases it on fd close/exit.
 * Lock the whole cache because each host update rewrites the same JSON document.
 */
export async function withTokenCacheLock<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  waitTimeoutMs = 180_000,
): Promise<T> {
  const directory = path.join(os.homedir(), '.palantir')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const file = await fs.open(path.join(directory, 'mcp-config.json.lock'), 'a', 0o600)
  const deadline = performance.now() + waitTimeoutMs
  try {
    // tryLock returns false ONLY for contention. Permission, unsupported filesystem,
    // and native-addon errors fail immediately; never fall back to unlocked auth.
    while (!tryLock(file.fd)) {
      const remaining = deadline - performance.now()
      if (remaining <= 0)
        throw new Error('Timed out waiting for another MCP authentication process')
      await delay(Math.min(250, remaining))
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('MCP authentication timed out')),
      90_000,
    )
    try {
      const result = await operation(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timer)
    }
  } finally {
    // Closing releases only THIS descriptor's lock; it cannot remove another
    // owner's lock. Do not race operation() with a timeout and release it early.
    await file.close()
  }
}
