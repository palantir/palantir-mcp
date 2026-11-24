/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Lock acquisition failed before the operation ran; the operation's own errors are never wrapped. */
export class FileLockError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'busy',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface FileLockOptions {
  /** Runs after the native addon loads and before the lock file opens, e.g. to create its directory. */
  prepare?: () => Promise<void>
  waitTimeoutMs: number
  /** Cancels waiting for ownership. */
  signal?: AbortSignal
}

/**
 * Exclusive kernel lock on a permanent lock file: flock (macOS), OFD locks (Linux), LockFileEx
 * (Windows). The same protocol as the private `@palantir/mcp` runtime, so either package blocks
 * the other. NEVER unlink/replace the lock file, including during cleanup. The kernel holds
 * ownership across suspension and releases it on fd close/exit, so there is no stale lock.
 */
export async function withFileLock<T>(
  lockFile: string,
  operation: () => Promise<T>,
  { prepare, waitTimeoutMs, signal }: FileLockOptions,
): Promise<T> {
  // Legacy and non-interactive paths must not require a native addon. Load it only when
  // coordination is needed, and never continue unlocked.
  const { tryLock } = await import('fs-native-extensions').catch((cause) => {
    throw new FileLockError(
      'unavailable',
      'Native file locking is unavailable; refusing unlocked access',
      { cause },
    )
  })
  await prepare?.()
  // "a+", not "a": LockFileEx needs read or write-data access, and libuv opens "a" handles append-only.
  const file = await fs.open(lockFile, 'a+', 0o600)
  const deadline = performance.now() + waitTimeoutMs
  try {
    // tryLock returns false ONLY for contention. Permission, unsupported filesystem and
    // native-addon errors fail immediately; never fall back to unlocked access.
    while (!tryLock(file.fd)) {
      signal?.throwIfAborted()
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new FileLockError('busy', 'Timed out waiting for another process')
      // Cancellation interrupts the wait at once and surfaces the caller's abort reason.
      await delay(Math.min(250, remaining), undefined, { signal }).catch((error) => {
        signal?.throwIfAborted()
        throw error
      })
    }
    signal?.throwIfAborted()
    return await operation()
  } finally {
    // Closing releases only THIS descriptor's lock; it cannot remove another owner's lock.
    await file.close()
  }
}
