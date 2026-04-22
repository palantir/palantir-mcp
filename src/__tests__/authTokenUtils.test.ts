/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { AuthoringApi } from '@api/authoringApi.js'
import { MultipassApi } from '@api/multipassApi.js'
import { ConjureError, ConjureErrorType } from 'conjure-client'
import { InvalidAuthTokenError } from 'src/errors.js'
import { isTokenExpired, retrieveTokenFromSecret } from 'src/utils/authTokenUtils.js'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@api/multipassApi.js')
vi.mock('@api/authoringApi.js')

function createInvalidJwtError(): ConjureError<any> {
  return new ConjureError(ConjureErrorType.Status, new Error('Invalid JWT'), 401, {
    errorCode: 'UNAUTHORIZED',
    parameters: { error: 'INVALID_JWT' },
  })
}

function createInvalidTokenSignatureError(): ConjureError<any> {
  return new ConjureError(ConjureErrorType.Status, new Error('Invalid token signature'), 401, {
    errorName: 'Authoring:InvalidTokenSignature',
  })
}

describe('authTokenUtils', () => {
  const mockMultipassApi = {
    getTokenTimeToLiveInSeconds: vi.fn(),
    context: { apiUrl: { hostname: 'test.palantirfoundry.com' } },
  } as unknown as MultipassApi

  const mockAuthoringApi = {
    retrieveToken: vi.fn(),
    context: { apiUrl: { hostname: 'test.palantirfoundry.com' } },
  } as unknown as AuthoringApi

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isTokenExpired', () => {
    it('should return false when token has sufficient TTL', async () => {
      vi.mocked(mockMultipassApi.getTokenTimeToLiveInSeconds).mockResolvedValue(3600)
      expect(await isTokenExpired(mockMultipassApi, 300)).toBe(false)
    })

    it('should return true when token has insufficient TTL', async () => {
      vi.mocked(mockMultipassApi.getTokenTimeToLiveInSeconds).mockResolvedValue(100)
      expect(await isTokenExpired(mockMultipassApi, 300)).toBe(true)
    })

    it('should throw InvalidAuthTokenError for invalid JWT', async () => {
      vi.mocked(mockMultipassApi.getTokenTimeToLiveInSeconds).mockRejectedValue(
        createInvalidJwtError(),
      )
      await expect(isTokenExpired(mockMultipassApi, 300)).rejects.toThrow(InvalidAuthTokenError)
    })

    it('should return true on other errors', async () => {
      vi.mocked(mockMultipassApi.getTokenTimeToLiveInSeconds).mockRejectedValue(
        new Error('Network error'),
      )
      expect(await isTokenExpired(mockMultipassApi, 300)).toBe(true)
    })
  })

  describe('retrieveTokenFromSecret', () => {
    it('should return token on success', async () => {
      vi.mocked(mockAuthoringApi.retrieveToken).mockResolvedValue('test-token')
      expect(await retrieveTokenFromSecret('test-secret', mockAuthoringApi)).toBe('test-token')
    })

    it('should throw InvalidAuthTokenError for invalid token signature', async () => {
      vi.mocked(mockAuthoringApi.retrieveToken).mockRejectedValue(
        createInvalidTokenSignatureError(),
      )
      await expect(retrieveTokenFromSecret('test-secret', mockAuthoringApi)).rejects.toThrow(
        InvalidAuthTokenError,
      )
    })

    it('should return undefined on other errors', async () => {
      vi.mocked(mockAuthoringApi.retrieveToken).mockRejectedValue(new Error('Network error'))
      expect(await retrieveTokenFromSecret('test-secret', mockAuthoringApi)).toBeUndefined()
    })
  })
})
