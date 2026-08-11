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

  // Mocks receive the token the TokenRefreshUtils was constructed with, so tests
  // can drive per-token behaviour (e.g. cached expired, CLI valid).
  let mockIsExpired: ReturnType<typeof vi.fn>
  let mockForceRefreshToken: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()

    mockIsExpired = vi.fn().mockResolvedValue(false)
    mockForceRefreshToken = vi.fn()
    vi.mocked(TokenRefreshUtils).mockImplementation(
      (_apiUrl: URL, token: string) =>
        ({
          isExpired: () => mockIsExpired(token),
          forceRefreshToken: () => mockForceRefreshToken(token),
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
      mockIsExpired.mockResolvedValue(false) // token still valid
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
        text: () => Promise.resolve('{}'),
      })
      await expect(checkPackageAvailability(npmRegistry, foundryToken)).rejects.toThrow(
        PackageFetchError,
      )
    })

    it('should report the HTTP status when the registry returns an HTML error body', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('<html><body>Unauthorized</body></html>'),
      })

      const error = await checkPackageAvailability(npmRegistry, foundryToken).catch((e) => e)

      expect(error).toBeInstanceOf(PackageFetchError)
      expect((error as PackageFetchError).cause).toMatchObject({
        message: expect.stringContaining('unexpected status 401'),
      })
      expect(consoleError).toHaveBeenCalledWith('<html><body>Unauthorized</body></html>')
    })

    it('should report the HTTP status when the registry returns an empty error body', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve(''),
      })

      const error = await checkPackageAvailability(npmRegistry, foundryToken).catch((e) => e)

      expect(error).toBeInstanceOf(PackageFetchError)
      expect((error as PackageFetchError).cause).toMatchObject({
        message: expect.stringContaining('unexpected status 403'),
      })
      expect(consoleError).toHaveBeenCalledWith('<empty response body>')
    })

    it('should still log a JSON error body as structured output', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"errorCode":"NOT_FOUND"}'),
      })

      const error = await checkPackageAvailability(npmRegistry, foundryToken).catch((e) => e)

      expect(error).toBeInstanceOf(PackageFetchError)
      expect((error as PackageFetchError).cause).toMatchObject({
        message: expect.stringContaining('unexpected status 404'),
      })
      expect(consoleError).toHaveBeenCalledWith({ errorCode: 'NOT_FOUND' })
    })

    it('should truncate an oversized non-JSON error body', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve('x'.repeat(5000)),
      })

      const error = await checkPackageAvailability(npmRegistry, foundryToken).catch((e) => e)

      expect(error).toBeInstanceOf(PackageFetchError)
      expect(consoleError).toHaveBeenCalledWith(`${'x'.repeat(500)}... (truncated)`)
    })

    it('should report the HTTP status when the error body cannot be read', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.reject(new Error('socket hang up')),
      })

      const error = await checkPackageAvailability(npmRegistry, foundryToken).catch((e) => e)

      expect(error).toBeInstanceOf(PackageFetchError)
      expect((error as PackageFetchError).cause).toMatchObject({
        message: expect.stringContaining('unexpected status 503'),
      })
      expect(consoleError).toHaveBeenCalledWith('<unreadable response body>')
    })
  })

  describe('validateFoundryToken', () => {
    it('should return the cached token when it is still valid', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockIsExpired.mockResolvedValue(false)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CACHED_TOKEN)
      expect(mockForceRefreshToken).not.toHaveBeenCalled()
    })

    it('should prefer a valid CLI/env token over an expired cached token without opening a browser', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      // Cached token is expired; the explicitly provided CLI/env token is valid.
      mockIsExpired.mockImplementation(async (token: string) => token === CACHED_TOKEN)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CLI_TOKEN)
      // The valid provided token must win with no interactive browser flow.
      expect(mockForceRefreshToken).not.toHaveBeenCalled()
    })

    it('should interactively refresh the cached token when no token is currently valid', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockIsExpired.mockResolvedValue(true) // both cached and CLI expired
      mockForceRefreshToken.mockResolvedValue(REFRESHED_TOKEN)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(REFRESHED_TOKEN)
      // Cached token is refreshed first.
      expect(mockForceRefreshToken).toHaveBeenCalledWith(CACHED_TOKEN)
    })

    it('should skip a cached token that is invalid for this stack and use a valid CLI token', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockIsExpired.mockImplementation(async (token: string) => {
        if (token === CACHED_TOKEN) {
          throw new InvalidAuthTokenError(foundryApiUrl.hostname)
        }
        return false // CLI token is valid
      })

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CLI_TOKEN)
      expect(mockForceRefreshToken).not.toHaveBeenCalled()
    })

    it('should throw when every token is invalid for this stack', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CACHED_TOKEN)
      mockIsExpired.mockRejectedValue(new InvalidAuthTokenError(foundryApiUrl.hostname))

      await expect(validateFoundryToken(foundryApiUrl, CLI_TOKEN)).rejects.toThrow(
        NoTokenAvailableError,
      )
      expect(mockForceRefreshToken).not.toHaveBeenCalled()
    })

    it('should deduplicate when cached and CLI tokens are identical', async () => {
      vi.mocked(tokenCache.loadCachedToken).mockReturnValue(CLI_TOKEN)
      mockIsExpired.mockResolvedValue(false)

      const result = await validateFoundryToken(foundryApiUrl, CLI_TOKEN)

      expect(result).toBe(CLI_TOKEN)
      // Should only create one TokenRefreshUtils, not two
      expect(TokenRefreshUtils).toHaveBeenCalledTimes(1)
    })

    it('should use the git token only for browser auth bootstrap via forceRefreshToken', async () => {
      // No cached or CLI token — only git token available
      vi.mocked(gitConfigParser.parseGitToken).mockReturnValue('git-token')
      mockForceRefreshToken.mockResolvedValue(REFRESHED_TOKEN)

      const result = await validateFoundryToken(foundryApiUrl, undefined)

      expect(result).toBe(REFRESHED_TOKEN)
      expect(mockForceRefreshToken).toHaveBeenCalledWith('git-token')
      // isExpired is never consulted for the git bootstrap path.
      expect(mockIsExpired).not.toHaveBeenCalled()
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
