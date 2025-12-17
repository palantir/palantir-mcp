/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { ConjureError, isConjureError } from 'conjure-client'
import { InvalidAuthTokenError } from 'src/errors.js'
import { BaseApi } from './baseApi.js'
import { HttpRequestContext } from './httpRequestContext.js'

export class AuthoringApi extends BaseApi {
  constructor(context: HttpRequestContext) {
    super(context, 'code/api', 'authoringService')
  }

  async retrieveToken(secret: string): Promise<string | undefined> {
    try {
      console.debug('Attempting to retrieve token...')

      const token: string | undefined = await this.post<string | undefined>(
        'security/token/retrieve',
        'retrieveToken',
        secret,
      )
      return token
    } catch (error: unknown) {
      this.throwIfInvalidTokenError(error)
      // if it is not an InvalidAuthTokenError, swallow it and keep trying
    }
    return undefined
  }

  private throwIfInvalidTokenError(error: unknown): void {
    console.error('Error retrieving token:', error)
    if (isConjureError(error)) {
      const conjureError: ConjureError<any> = error

      if (typeof conjureError.body === 'string') {
        console.debug('Conjure error body as string:', conjureError.body)
      } else {
        console.debug('Conjure error body as object:', conjureError.body)
        const conjureErroName = conjureError.body?.errorName

        if (conjureErroName === 'Authoring:InvalidTokenSignature') {
          throw new InvalidAuthTokenError(this.context.apiUrl.hostname)
        }
      }
    }
  }
}
