/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolvePalantirMcpPackageSpec, spawnMcp } from '../spawn.js'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

describe('spawn', () => {
  const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.PALANTIR_MCP_PACKAGE
  })

  describe('spawnMcp', () => {
    it('should spawn npx with correct arguments', () => {
      const mockChild = {
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(mockChild)

      const options = {
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: ['--help', '--verbose'],
      }

      spawnMcp(options)

      const isWindows = process.platform === 'win32'
      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['-y', '@palantir/mcp@latest', '--help', '--verbose'],
        expect.objectContaining({
          stdio: 'inherit',
          // shell only on Windows (needed for .cmd resolution).
          // On Linux/macOS shell: false avoids /bin/sh dropping env vars
          // whose names contain / and : (the npm auth token key).
          shell: isWindows,
        }),
      )
    })

    it('should set correct environment variables', () => {
      const mockChild = {
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(mockChild)

      const options = {
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      }

      spawnMcp(options)

      const spawnCall = mockSpawn.mock.calls[0]
      const env = spawnCall[2].env

      expect(env.NPM_CONFIG_REGISTRY).toBe('https://example.com/npm/')
      expect(env['NPM_CONFIG_//example.com/npm/:_authToken']).toBe('test-token')
    })

    it('should preserve existing environment variables', () => {
      const mockChild = {
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(mockChild)

      const originalEnv = process.env
      process.env.CUSTOM_VAR = 'custom-value'

      const options = {
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      }

      spawnMcp(options)

      const spawnCall = mockSpawn.mock.calls[0]
      const env = spawnCall[2].env

      expect(env.CUSTOM_VAR).toBe('custom-value')

      process.env = originalEnv
    })

    it('should register SIGINT signal handler', () => {
      const mockChild = {
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(mockChild)

      const originalListenerCount = process.listenerCount('SIGINT')

      const options = {
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      }

      spawnMcp(options)

      expect(process.listenerCount('SIGINT')).toBe(originalListenerCount + 1)
    })

    it('should register SIGTERM signal handler', () => {
      const mockChild = {
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(mockChild)

      const originalListenerCount = process.listenerCount('SIGTERM')

      const options = {
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      }

      spawnMcp(options)

      expect(process.listenerCount('SIGTERM')).toBe(originalListenerCount + 1)
    })

    it('should use PALANTIR_MCP_PACKAGE when set for pin workaround', () => {
      const mockChild = { kill: vi.fn() }
      mockSpawn.mockReturnValue(mockChild)
      process.env.PALANTIR_MCP_PACKAGE = '@palantir/mcp@0.305.0'

      spawnMcp({
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      })

      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['-y', '@palantir/mcp@0.305.0'],
        expect.anything(),
      )
    })
  })

  describe('resolvePalantirMcpPackageSpec', () => {
    it('defaults to @palantir/mcp@latest', () => {
      delete process.env.PALANTIR_MCP_PACKAGE
      expect(resolvePalantirMcpPackageSpec()).toBe('@palantir/mcp@latest')
    })

    it('accepts pinned Palantir MCP version', () => {
      process.env.PALANTIR_MCP_PACKAGE = '@palantir/mcp@0.305.0'
      expect(resolvePalantirMcpPackageSpec()).toBe('@palantir/mcp@0.305.0')
    })

    it('rejects non-palantir package prefix', () => {
      process.env.PALANTIR_MCP_PACKAGE = 'evil@1.0.0'
      expect(() => resolvePalantirMcpPackageSpec()).toThrow(/must start with @palantir\/mcp@/)
    })
  })
})
