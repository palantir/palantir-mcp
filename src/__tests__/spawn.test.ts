/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { spawnMcp } from '../spawn.js'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

describe('spawn', () => {
  const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>
  const signalListeners: Array<{ event: string; listener: () => void }> = []

  beforeEach(() => {
    vi.clearAllMocks()
    const originalOn = process.on.bind(process)
    vi.spyOn(process, 'on').mockImplementation((event: string, listener: any) => {
      signalListeners.push({ event, listener })
      return originalOn(event, listener)
    })
  })

  afterEach(() => {
    for (const { event, listener } of signalListeners) {
      process.removeListener(event, listener)
    }
    signalListeners.length = 0
    vi.restoreAllMocks()
  })

  describe('spawnMcp', () => {
    it('should spawn npx with correct arguments', () => {
      const mockChild = { on: vi.fn(), kill: vi.fn() }
      mockSpawn.mockReturnValue(mockChild)

      const options = {
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: ['--help', '--verbose'],
      }

      spawnMcp(options)

      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['-y', '@palantir/mcp@latest', '--help', '--verbose'],
        expect.objectContaining({
          stdio: 'inherit',
          shell: true,
        }),
      )
    })

    it('should set correct environment variables', () => {
      const mockChild = { on: vi.fn(), kill: vi.fn() }
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
      const mockChild = { on: vi.fn(), kill: vi.fn() }
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

    it('should register child exit and error handlers', () => {
      const mockChild = { on: vi.fn(), kill: vi.fn() }
      mockSpawn.mockReturnValue(mockChild)

      spawnMcp({
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      })

      expect(mockChild.on).toHaveBeenCalledWith('exit', expect.any(Function))
      expect(mockChild.on).toHaveBeenCalledWith('error', expect.any(Function))
    })

    it('should forward SIGINT and SIGTERM to child', () => {
      const mockChild = { on: vi.fn(), kill: vi.fn() }
      mockSpawn.mockReturnValue(mockChild)

      const originalSigintCount = process.listenerCount('SIGINT')
      const originalSigtermCount = process.listenerCount('SIGTERM')

      spawnMcp({
        npmRegistry: new URL('https://example.com/npm/'),
        foundryToken: 'test-token',
        args: [],
      })

      expect(process.listenerCount('SIGINT')).toBe(originalSigintCount + 1)
      expect(process.listenerCount('SIGTERM')).toBe(originalSigtermCount + 1)
    })
  })
})
