/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runOAuthRuntime } from '../auth/runtime.js'
import {
  checkNetworkConnectivity,
  checkPackageAvailability,
  validateFoundryToken,
} from '../preflightChecks.js'
import { buildNpmRegistryUrl } from '../registry.js'

vi.mock('child_process', () => ({ spawn: vi.fn(() => ({ kill: vi.fn() })) }))
vi.mock('../preflightChecks.js', () => ({
  checkNodeVersion: vi.fn(),
  checkNetworkConnectivity: vi.fn(async () => {}),
  validateFoundryToken: vi.fn(async () => 'validated-token'),
  checkPackageAvailability: vi.fn(async () => {}),
}))
vi.mock('../auth/runtime.js', () => ({ runOAuthRuntime: vi.fn() }))

process.env.PALANTIR_MCP_NO_AUTOSTART = '1'

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>
const host = 'https://example.palantirfoundry.com'
const registry = buildNpmRegistryUrl(new URL(host))
const authKey = `NPM_CONFIG_//${registry.host + registry.pathname}:_authToken`

describe('legacy startup matches develop', () => {
  const previous = { ...process.env }
  afterEach(() => {
    process.env = { ...previous }
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('passes develop argv and environment, including an explicit legacy selector stripped first', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('legacy startup must not use the network directly')
    })
    const { main } = await import('../index.js')
    process.env.FOUNDRY_TOKEN = 'env-token'
    process.env.OTHER = 'kept'
    process.env['npm_config_//other/:_authToken'] = 'inherited-npm-token'
    await main([
      'node',
      'palantir-mcp',
      '--auth=legacy',
      '--foundry-api-url',
      host,
      '--foundry-token',
      'cli-token',
      '--disable-tools',
      'x',
    ])
    expect(validateFoundryToken).toHaveBeenCalledWith(new URL(host), 'cli-token')
    expect(checkNetworkConnectivity).toHaveBeenCalledOnce()
    expect(checkPackageAvailability).toHaveBeenCalledWith(registry, 'validated-token')
    expect(runOAuthRuntime).not.toHaveBeenCalled()
    expect(mockSpawn).toHaveBeenCalledWith(
      'npx',
      [
        '-y',
        '@palantir/mcp@latest',
        '--foundry-api-url',
        host,
        '--foundry-token',
        'cli-token',
        '--disable-tools',
        'x',
      ],
      expect.objectContaining({
        stdio: 'inherit',
        shell: process.platform === 'win32',
      }),
    )
    const env = mockSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv
    expect(env.FOUNDRY_TOKEN).toBe('validated-token')
    expect(env.NPM_CONFIG_REGISTRY).toBe(registry.toString())
    expect(env[authKey]).toBe('validated-token')
    expect(env.OTHER).toBe('kept')
    expect(env['npm_config_//other/:_authToken']).toBe('inherited-npm-token')
  })
})
