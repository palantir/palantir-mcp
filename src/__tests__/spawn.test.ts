/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { spawnMcp } from '../spawn.js'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

describe('spawnMcp', () => {
  const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockSpawn.mockReturnValue({ kill: vi.fn() })
  })

  it('should spawn npx with correct arguments and environment', () => {
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

    const env = mockSpawn.mock.calls[0][2].env
    expect(env.NPM_CONFIG_REGISTRY).toBe('https://example.com/npm/')
    expect(env['NPM_CONFIG_//example.com/npm/:_authToken']).toBe('test-token')
  })
})
