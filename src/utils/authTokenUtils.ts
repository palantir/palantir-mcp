/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { AuthoringApi } from '@api/authoringApi.js'
import { MultipassApi } from '@api/multipassApi.js'
import { isConjureError } from 'conjure-client'
import { InvalidAuthTokenError } from 'src/errors.js'
import {
  isExpiredTokenError,
  isInvalidAuthTokenSignature,
  isInvalidJwtError,
} from './conjureErrorUtils.js'

export async function isTokenExpired(
  multipassApi: MultipassApi,
  minimumTimeToLive: number,
): Promise<boolean> {
  try {
    const response = await multipassApi.getTokenTimeToLiveInSeconds()

    return response < minimumTimeToLive
  } catch (error: unknown) {
    // Token was signed by a different Foundry stack — cannot be refreshed here.
    if (isInvalidJwtError(error)) {
      throw new InvalidAuthTokenError(multipassApi.context.apiUrl.hostname)
    }

    // Token was issued by this stack but has expired — can be refreshed via browser auth.
    if (isExpiredTokenError(error)) {
      return true
    }

    // Any other Conjure error (403 RequestBlocked, etc.) means the token is invalid
    // for this stack — do not attempt browser auth.
    if (isConjureError(error)) {
      throw new InvalidAuthTokenError(multipassApi.context.apiUrl.hostname)
    }

    // Non-Conjure errors (network issues, etc.) — assume expired and attempt refresh.
    return true
  }
}

export async function retrieveTokenFromSecret(
  secret: string,
  authoringApi: AuthoringApi,
): Promise<string | undefined> {
  try {
    const token: string | undefined = await authoringApi.retrieveToken(secret)
    return token
  } catch (error: unknown) {
    // if it is not an InvalidAuthTokenError, swallow it and keep trying
    if (isInvalidAuthTokenSignature(error)) {
      throw new InvalidAuthTokenError(authoringApi.context.apiUrl.hostname)
    }
  }
  return undefined
}
