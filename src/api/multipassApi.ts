/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { BaseApi } from './baseApi.js'

export class MultipassApi extends BaseApi {
  constructor(foundryHost: string) {
    super(foundryHost, 'multipass/api')
  }

  async getTokenTimeToLiveInSeconds(authToken: string): Promise<number> {
    const response = await this.get('token/ttl', authToken)

    if (response.ok) {
      try {
        const ttlString = await response.text()
        return parseInt(ttlString, 10)
      } catch {
        return 0
      }
    }

    throw Error(`Failed to get token TTL: ${response.status} ${response.statusText}`)
  }
}
