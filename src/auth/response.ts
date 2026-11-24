/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Release unread bodies without stalling startup. Never log server content or raw transport errors. */
export function discardBody(response: Response): void {
  if (!response.body || response.body.locked) return
  void response.body.cancel().catch(() => {
    console.error('Could not discard an unread OAuth response body.')
  })
}
