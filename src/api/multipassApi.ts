/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { isConjureError } from 'conjure-client'
import { InvalidAuthTokenError } from 'src/errors.js'
import { BaseApi } from './baseApi.js'
import { HttpRequestContext } from './httpRequestContext.js'

export class MultipassApi extends BaseApi {
  private static MINIMUM_TOKEN_TTL = 300

  constructor(context: HttpRequestContext) {
    super(context, 'multipass/api', 'multipassService')
  }

  public async isTokenExpired(): Promise<boolean> {
    try {
      const response = await this.getTokenTimeToLiveInSeconds()
      console.debug(`Token time to live: ${response} seconds`)

      return response < MultipassApi.MINIMUM_TOKEN_TTL
    } catch (error: unknown) {
      if (isConjureError(error)) {
        const conjureError = error.body as any

        // if we have an invalid JWT, we will not be able to refresh.
        if (
          conjureError.errorCode === 'UNAUTHORIZED' &&
          conjureError.parameters.error === 'INVALID_JWT'
        ) {
          throw new InvalidAuthTokenError(this.context.apiUrl.hostname)
        }
      }

      return true
    }
  }

  private async getTokenTimeToLiveInSeconds(): Promise<number> {
    return this.get('token/ttl', 'getTokenTimeToLiveInSeconds')
  }
}
