/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as client from '@osdk/client'
import * as foundryAdmin from '@osdk/foundry.admin'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AuthenticationError,
  NetworkError,
  NodeVersionError,
  PackageFetchError,
} from '../errors.js'
import { runPreflightChecks } from '../preflightChecks.js'

vi.mock('@osdk/client', () => ({
  createPlatformClient: vi.fn(),
}))

vi.mock('@osdk/foundry.admin', () => ({
  Users: {
    getCurrent: vi.fn(),
  },
}))

describe('preflightChecks', () => {
  const foundryApiUrl = new URL('https://example.palantirfoundry.com')
  const foundryToken = 'test-token'
  const npmRegistry = new URL('https://example.palantirfoundry.com/npm/')

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  describe('runPreflightChecks', () => {
    it('should pass all preflight checks successfully', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
      ;(client.createPlatformClient as any).mockReturnValue({})
      ;(foundryAdmin.Users.getCurrent as any).mockResolvedValue({})

      await expect(
        runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry),
      ).resolves.not.toThrow()
    })

    it('should throw NodeVersionError for Node version < 18', async () => {
      vi.spyOn(process.versions, 'node', 'get').mockReturnValue('16.14.0')

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        NodeVersionError,
      )
    })

    it('should throw NetworkError when cannot reach Foundry API', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any).mockRejectedValueOnce(new Error('Network error'))

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        NetworkError,
      )
    })

    it('should throw NetworkError when Foundry API returns non-OK status', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any).mockResolvedValueOnce({ ok: false, status: 404 })

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        NetworkError,
      )
    })

    it('should throw AuthenticationError for 401 responses', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any).mockResolvedValueOnce({ ok: true })
      ;(client.createPlatformClient as any).mockReturnValue({})
      ;(foundryAdmin.Users.getCurrent as any).mockRejectedValue({
        cause: { statusCode: 401 },
      })

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        AuthenticationError,
      )
    })

    it('should throw generic McpError for other API errors', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any).mockResolvedValueOnce({ ok: true })
      ;(client.createPlatformClient as any).mockReturnValue({})
      ;(foundryAdmin.Users.getCurrent as any).mockRejectedValue(new Error('Unknown error'))

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        'An unexpected error occurred when trying to connect to the Foundry API',
      )
    })

    it('should throw PackageFetchError when cannot fetch package', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any)
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('Fetch failed'))
      ;(client.createPlatformClient as any).mockReturnValue({})
      ;(foundryAdmin.Users.getCurrent as any).mockResolvedValue({})

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        PackageFetchError,
      )
    })

    it('should throw PackageFetchError when package endpoint returns non-OK status', async () => {
      const nodeVersion = process.versions.node
      const majorVersion = parseInt(nodeVersion.split('.')[0])
      if (majorVersion < 18) {
        vi.spyOn(process.versions, 'node', 'get').mockReturnValue('18.0.0')
      }

      ;(global.fetch as any)
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, status: 500 })
      ;(client.createPlatformClient as any).mockReturnValue({})
      ;(foundryAdmin.Users.getCurrent as any).mockResolvedValue({})

      await expect(runPreflightChecks(foundryApiUrl, foundryToken, npmRegistry)).rejects.toThrow(
        PackageFetchError,
      )
    })
  })
})
