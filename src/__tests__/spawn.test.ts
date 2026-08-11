/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { McpLaunchError } from '../errors.js'
import { spawnMcp } from '../spawn.js'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

describe('spawn', () => {
  const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('spawnMcp', () => {
    it('should spawn npx with correct arguments', () => {
      const mockChild = {
        kill: vi.fn(),
        on: vi.fn(),
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
        on: vi.fn(),
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
        on: vi.fn(),
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
        on: vi.fn(),
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
        on: vi.fn(),
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
  })

  describe('child process outcome', () => {
    const options = {
      npmRegistry: new URL('https://example.com/npm/'),
      foundryToken: 'test-token',
      args: [],
    }

    function spawnWithHandlers() {
      const handlers: Record<string, (...callbackArgs: any[]) => void> = {}
      mockSpawn.mockReturnValue({
        kill: vi.fn(),
        on: vi.fn((event: string, handler: (...callbackArgs: any[]) => void) => {
          handlers[event] = handler
        }),
      })
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      spawnMcp(options)
      return { handlers, exit }
    }

    it('should exit with the code the MCP server exited with', () => {
      const { handlers, exit } = spawnWithHandlers()

      handlers.exit(42, null)

      expect(exit).toHaveBeenCalledWith(42)
      exit.mockRestore()
    })

    it('should exit 0 when the MCP server exits cleanly', () => {
      const { handlers, exit } = spawnWithHandlers()

      handlers.exit(0, null)

      expect(exit).toHaveBeenCalledWith(0)
      exit.mockRestore()
    })

    it('should report a signalled death as 128 + signal number', () => {
      const { handlers, exit } = spawnWithHandlers()

      handlers.exit(null, 'SIGTERM')

      expect(exit).toHaveBeenCalledWith(143)
      exit.mockRestore()
    })

    it('should exit non-zero when the child terminates without a code or signal', () => {
      const { handlers, exit } = spawnWithHandlers()

      handlers.exit(null, null)

      expect(exit).toHaveBeenCalledWith(1)
      exit.mockRestore()
    })

    it('should report a failed spawn instead of throwing an unhandled error', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { handlers, exit } = spawnWithHandlers()

      const cause = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' })
      handlers.error(cause)

      expect(consoleError).toHaveBeenCalledWith(expect.any(McpLaunchError))
      expect(consoleError.mock.calls[0][0].cause).toBe(cause)
      expect(exit).toHaveBeenCalledWith(1)
      exit.mockRestore()
      consoleError.mockRestore()
    })
  })
})
