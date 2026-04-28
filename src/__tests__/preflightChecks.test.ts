/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  InvalidAuthTokenError,
  NetworkError,
  NodeVersionError,
  NoTokenAvailableError,
  PackageFetchError,
} from '../errors.js'
import {
  checkNodeVersion,
  checkNetworkConnectivity,
  validateFoundryToken,
  checkPackageAvailability,
} from '../preflightChecks.js'
import * as gitConfigParser from '../utils/gitConfigParser.js'
import * as tokenCache from '../utils/tokenCache.js'
import { TokenRefreshUtils } from '../utils/tokenRefreshUtils.js'

vi.mock('../utils/tokenRefreshUtils.js')
vi.mock('../utils/tokenCache.js', async (importOriginal) => {
  const original = await importOriginal<typeof tokenCache>()
  return {
    ...original,
    loadCachedToken: vi.fn(),
  }
})
vi.mock('../utils/gitConfigParser.js', () => ({
  parseGitToken: vi.fn(),
}))

const CACHED_TOKEN = 'cached-token'
const CLI_TOKEN = 'cli-token'
const REFRESHED_TOKEN = 'refreshed-token'

describe('preflightChecks', () => {
  const foundryApiUrl = new URL('https://example.palantirfoundry.com')
  const foundryToken = 'test-token'
  const npmRegistry = new URL('https://example.palantirfoundry.com/npm/')

  let mockRefreshTokenIfExpired: ReturnType<typeof vi.fn>
  let mockForceRefreshToken: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()

    mockRefreshTokenIfExpired = vi.fn()
    mockForceRefreshToken = vi.fn()
    vi.mocked(TokenRefreshUtils).mockImplementation(
      () =>
        ({
          refreshTokenIfExpired: mockRefreshTokenIfExpired,
          forceRefreshToken: mockForceRefreshToken,
        }) as unknown as TokenRefreshUtils,
    )
    vi.mocked(tokenCache.loadCachedToken).mockReturnValue(undefined)
    vi.mocked(gitConfigParser.parseGitToken).mockReturnValue(undefined)
  })

  describe('individual preflight checks', () => {
    it('should pass all preflight checks successfully', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockRefreshTokenIfExpired.mockResolvedValue(undefined) // token still valid
      ;(global.fetch as any).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })

      expect(() => checkNodeVersion()).not.toThrow()
      await expect(checkNetworkConnectivity(foundryApiUrl)).resolves.not.toThrow()
      const validatedToken = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)
      expect(validatedToken).toBe(CACHED_TOKEN)
      await expect(checkPackageAvailability(npmRegistry, validatedToken)).resolves.not.toThrow()
    })

    it('should throw NodeVersionError for Node version < 18', () => {
      vi.spyOn(process.versions, 'node', 'get').mockReturnValue('16.14.0')
      expect(() => checkNodeVersion()).toThrow(NodeVersionError)
    })

    it('should throw NetworkError when cannot reach Foundry API', async () => {
      ;(global.fetch as any).mockRejectedValueOnce(new Error('Network error'))
      await expect(checkNetworkConnectivity(foundryApiUrl)).rejects.toThrow(NetworkError)
    })

    it('should throw NetworkError when Foundry API returns non-OK status', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({ ok: false, status: 404 })
      await expect(checkNetworkConnectivity(foundryApiUrl)).rejects.toThrow(NetworkError)
    })

    it('should throw PackageFetchError when cannot fetch package', async () => {
      ;(global.fetch as any).mockRejectedValueOnce(new Error('Fetch failed'))
      await expect(checkPackageAvailability(npmRegistry, foundryToken)).rejects.toThrow(
        PackageFetchError,
      )
    })

    it('should throw PackageFetchError when package endpoint returns non-OK status', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      })
      await expect(checkPackageAvailability(npmRegistry, foundryToken)).rejects.toThrow(
        PackageFetchError,
      )
    })
  })

  describe('validateFoundryToken', () => {
    it('should return cached token when it is still valid', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockRefreshTokenIfExpired.mockResolvedValue(undefined)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CACHED_TOKEN)
    })

    it('should return refreshed token when cached token is expired', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockRefreshTokenIfExpired.mockResolvedValue(REFRESHED_TOKEN)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(REFRESHED_TOKEN)
    })

    it('should fall back to CLI token when cached token is invalid', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockRefreshTokenIfExpired
        .mockRejectedValueOnce(new InvalidAuthTokenError(foundryApiUrl.hostname))
        .mockResolvedValueOnce(undefined) // CLI token is valid

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CLI_TOKEN)
      expect(TokenRefreshUtils).toHaveBeenCalledTimes(2)
    })

    it('should throw when all tokens are invalid', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockRefreshTokenIfExpired.mockRejectedValue(new InvalidAuthTokenError(foundryApiUrl.hostname))

      await expect(validateFoundryToken(foundryApiUrl, CLI_TOKEN)).rejects.toThrow(
        NoTokenAvailableError,
      )
    })

    it('should deduplicate when cached and CLI tokens are identical', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CLI_TOKEN)
      mockRefreshTokenIfExpired.mockResolvedValue(undefined)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CLI_TOKEN)
      // Should only create one TokenRefreshUtils, not two
      expect(TokenRefreshUtils).toHaveBeenCalledTimes(1)
    })

    it('should use git token only for browser auth bootstrap via forceRefreshToken', async () => {
      // No cached or CLI token — only git token available
      vi.mocked(gitConfigParser.parseGitToken).mockReturnValue('git-token')
      mockForceRefreshToken.mockResolvedValue(REFRESHED_TOKEN)

      const result = await validateFoundryToken(foundryApiUrl, undefined)

      expect(result).toBe(REFRESHED_TOKEN)
      // Should use forceRefreshToken (not refreshTokenIfExpired) for git tokens
      expect(mockForceRefreshToken).toHaveBeenCalledTimes(1)
      expect(mockRefreshTokenIfExpired).not.toHaveBeenCalled()
    })

    it('should throw when git token force refresh fails', async () => {
      vi.mocked(gitConfigParser.parseGitToken).mockReturnValue('git-token')
      mockForceRefreshToken.mockRejectedValue(new Error('browser auth failed'))

      await expect(validateFoundryToken(foundryApiUrl, undefined)).rejects.toThrow(
        NoTokenAvailableError,
      )
    })

    it('should throw NoTokenAvailableError when no candidates exist', async () => {
      await expect(validateFoundryToken(foundryApiUrl, undefined)).rejects.toThrow(
        NoTokenAvailableError,
      )
    })
  })
})
