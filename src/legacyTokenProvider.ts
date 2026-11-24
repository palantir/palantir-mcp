/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { validateFoundryToken } from './preflightChecks.js'
import { TokenProvider } from './tokenProvider.js'

/** Preserve the legacy resolver's cache, CLI/env, renewal and Git bootstrap ordering. */
export class LegacyTokenProvider implements TokenProvider {
  constructor(
    private readonly host: URL,
    private readonly cliToken: string | undefined,
  ) {}

  getToken(): Promise<string> {
    return validateFoundryToken(this.host, this.cliToken)
  }
}
