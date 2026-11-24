/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Credential providers own acquisition; callers never select a legacy fallback. */
export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>
}
