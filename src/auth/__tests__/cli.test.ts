/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthOptions, authConfig, TOOL_PERMISSION_GROUP_NAMES } from '../config.js'
import { credentialBinding } from '../store.js'
import { oauthMetadata } from './fixtures/oauthMetadata.js'

// Build an isolated bundle: the package-version E2E test rebuilds and removes dist concurrently.
let bundleDirectory: string
let bundle: string
beforeAll(async () => {
  bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-bundle-'))
  bundle = path.join(bundleDirectory, 'index.mjs')
  await fs.symlink(path.resolve('node_modules'), path.join(bundleDirectory, 'node_modules'), 'dir')
  const built = spawnSync(
    path.resolve('node_modules/.bin/esbuild'),
    [
      'src/index.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--external:commander',
      '--external:@osdk/*',
      '--external:fs-native-extensions',
      '--target=node18',
      `--outfile=${bundle}`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  )
  expect(built.status, built.stderr).toBe(0)
})
afterAll(async () => {
  await fs.rm(bundleDirectory, { recursive: true, force: true })
})

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-cli-'))
  // Any regression into registry/network/browser/spawn must be observable, not a plausible auth error.
  await fs.writeFile(
    path.join(home, 'guard.cjs'),
    `
const fail = () => { process.stderr.write('FORBIDDEN_SIDE_EFFECT'); process.exit(93) };
global.fetch = fail;
const cp = require('node:child_process'); cp.spawn = fail; cp.exec = fail;
require('node:module').syncBuiltinESMExports();
`,
  )
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})
const run = (args: string[]) =>
  spawnSync(
    process.env.WRAPPER_TEST_NODE ?? process.execPath,
    ['--require', path.join(home, 'guard.cjs'), bundle, ...args],
    {
      cwd: home,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        FOUNDRY_TOKEN: 'synthetic-env-secret',
      },
    },
  )
const options = ['--foundry-api-url', 'https://example.com']
/** Entries of ~/.palantir other than the OAuth store: the legacy cache and its lock. */
const legacyCacheEntries = async () =>
  (await fs.readdir(path.join(home, '.palantir')).catch(() => [])).filter(
    (name) => name !== 'mcp-oauth',
  )

describe('built public CLI boundary', () => {
  it('logs out without network, private package, legacy cache or stdout', async () => {
    const result = run(['auth', 'logout', ...options])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('not revoked')
    expect(await legacyCacheEntries()).toEqual([])
  })
  it.each(['login', 'refresh', 'status', 'logout'])(
    'rejects explicit legacy mode for auth %s before any side effects',
    (operation) => {
      const result = run(['auth', operation, ...options, '--auth=legacy'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('do not apply to --auth=legacy')
      expect(result.stderr).not.toContain('FORBIDDEN')
      expect(result.stdout).toBe('')
    },
  )
  it.each([{ flags: ['--auth=oauth'] }, { flags: ['--auth', 'oauth'] }])(
    'accepts explicit OAuth mode on credential commands ($flags)',
    ({ flags }) => {
      const result = run(['auth', 'status', ...options, ...flags])
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('No OAuth credential')
      expect(result.stdout).toBe('')
    },
  )
  it('missing refresh state attempts browser authorization but never legacy/download', async () => {
    await fs.writeFile(path.join(home, 'guard.cjs'), OBSERVING_GUARD)
    const result = run(['auth', 'refresh', ...options])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('FORBIDDEN')
    expect(result.stderr).not.toContain('synthetic-env-secret')
  })
  it.each(
    [
      ['--oauth'],
      ['--oauth-client-id', 'test'],
      ['--auth=legacy', '--oauth-profile', 'work'],
      ['--auth=other'],
    ].map((flags) => ({ flags })),
  )('rejects $flags before any preflight, credential lookup or download', ({ flags }) => {
    const result = run([...flags, '--foundry-api-url', 'https://example.com'])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('FORBIDDEN')
    expect(result.stderr).not.toContain('synthetic-env-secret')
  })
  it('rejects --auth=oauth with an explicit --foundry-token without echoing it', () => {
    const result = run(['--auth=oauth', ...options, '--foundry-token', 'synthetic-argument-secret'])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('conflicts with --foundry-token')
    expect(result.stderr).not.toContain('synthetic-argument-secret')
    expect(result.stderr).not.toContain('FORBIDDEN')
  })
  it.each(['--disable-tools', '--tool-groups', '--oauth-groups', '--oauth-required-scopes'])(
    'rejects unsupported auth option %s without side effects',
    (option) => {
      const result = run(['auth', 'login', ...options, option, 'synthetic-input'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Invalid auth command or options')
      expect(result.stderr).not.toContain('synthetic-input')
      expect(result.stderr).not.toContain('FORBIDDEN')
    },
  )
  it('rejects explicit token arguments on auth without echoing their values', () => {
    const result = run([
      'auth',
      'logout',
      ...options,
      '--foundry-token',
      'synthetic-argument-secret',
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('synthetic-argument-secret')
    expect(result.stdout).toBe('')
  })
  it.each(['env', 'cli', 'cache'])(
    'preserves built legacy %s selection, registry and child environment',
    async (source) => {
      const expected = `synthetic-${source === 'env' ? 'env-secret' : source}`
      if (source === 'cache') {
        await fs.mkdir(path.join(home, '.palantir'))
        await fs.writeFile(
          path.join(home, '.palantir/mcp-config.json'),
          JSON.stringify({ hosts: { 'https://example.com': { token: expected } } }),
        )
      }
      await fs.writeFile(
        path.join(home, 'guard.cjs'),
        `
const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const calls = [];
global.fetch = async (url, options) => {
  calls.push({ url: String(url), authorization: new Headers(options?.headers).get('Authorization') });
  return new Response(JSON.stringify(String(url).includes('/token/ttl') ? 600 : {}), { headers: { 'Content-Type': 'application/json' } });
};
cp.exec = () => { process.stderr.write('FORBIDDEN_BROWSER'); process.exit(93) };
cp.spawn = (command, args, options) => {
  fs.writeFileSync(process.env.HOME + '/observed.json', JSON.stringify({ command, args, env: options.env, calls }));
  return new EventEmitter();
};
require('node:module').syncBuiltinESMExports();
`,
      )
      const extra = source === 'env' ? [] : ['--foundry-token', 'synthetic-cli']
      const args = [
        '--foundry-api-url',
        'https://example.com',
        ...extra,
        '--private-option',
        'value',
      ]
      const result = run(args)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toContain('FORBIDDEN')
      const observed = JSON.parse(await fs.readFile(path.join(home, 'observed.json'), 'utf8'))
      expect(observed.command).toBe('npx')
      expect(observed.args).toEqual(['-y', '@palantir/mcp@latest', ...args])
      expect(observed.env.FOUNDRY_TOKEN).toBe(expected)
      expect(observed.env.NPM_CONFIG_REGISTRY).toContain('/contents/release/npm/')
      expect(Object.entries(observed.env).find(([key]) => key.endsWith(':_authToken'))?.[1]).toBe(
        expected,
      )
      expect(observed.calls).toHaveLength(3)
      expect(observed.calls[1].authorization).toBe(`Bearer ${expected}`)
      expect(observed.calls[2].authorization).toBe(`Bearer ${expected}`)
      expect(await fs.readdir(home)).not.toContain('.palantir-mcp-wrapper-oauth')
      await expect(fs.stat(path.join(home, '.palantir', 'mcp-oauth'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )
  it('shows standalone help without preflight', () => {
    const result = run(['auth', 'login', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--oauth-client-id')
    expect(result.stdout).not.toContain('--oauth-required-scopes')
    expect(result.stdout).not.toContain('--disable-tools')
    expect(result.stderr).not.toContain('FORBIDDEN')
  })
})

const READ = 'palantir-mcp:read-metadata'
const oauthRuntime = [
  '--auth=oauth',
  '--foundry-api-url',
  'https://example.com',
  '--oauth-client-id',
  'fixture',
  '--oauth-redirect',
  'http://127.0.0.1:49152/callback',
  '--oauth-scopes',
  `${READ} palantir-mcp:execute`,
]
const OBSERVING_GUARD = `
const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const calls = [];
const spawns = [];
const persist = () => fs.writeFileSync(process.env.HOME + '/observed.json', JSON.stringify({ calls, spawns }));
const fail = (what) => { process.stderr.write('FORBIDDEN_' + what); process.exit(93) };
global.fetch = async (url, options) => {
  url = String(url);
  calls.push({ url, authorization: new Headers(options?.headers).get('Authorization') });
  persist();
  if (url.includes('/token/ttl') || url.includes('/code/api/')) fail('LEGACY');
  if (url.includes('/.well-known/')) return new Response(JSON.stringify(${JSON.stringify(oauthMetadata())}));
  if (url.includes('/discovered/token')) fail('TOKEN_ENDPOINT');
  if (url.includes('%40palantir%2Fmcp')) return new Response(JSON.stringify({ 'dist-tags': { latest: '9.8.7' } }));
  return new Response('ok');
};
cp.exec = () => fail('EXEC');
cp.spawn = (command, args, options) => {
  spawns.push({ command, args, env: options.env, stdio: options.stdio });
  persist();
  const child = new EventEmitter();
  child.kill = () => true;
  // A browser launch fails fast; npx stages succeed without any download.
  setImmediate(() => child.emit('exit', command === 'npx' ? 0 : 1, null));
  return child;
};
require('node:module').syncBuiltinESMExports();
`

describe('built public CLI explicit OAuth runtime', () => {
  const seed = async (
    extra: Record<string, unknown> = {},
    overrides: Partial<AuthOptions> = {},
  ) => {
    const config = authConfig({
      foundryApiUrl: 'https://example.com',
      oauthClientId: 'fixture',
      oauthRedirect: 'http://127.0.0.1:49152/callback',
      oauthScopes: `${READ} palantir-mcp:execute`,
      ...overrides,
    })
    // Literal path: the layout is the contract shared with the private runtime.
    const directory = path.join(home, '.palantir', 'mcp-oauth')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const binding = credentialBinding(config)
    await fs.writeFile(
      path.join(directory, `${binding}.json`),
      JSON.stringify({
        version: 1,
        binding,
        accessToken: 'synthetic-oauth-access',
        refreshToken: 'synthetic-oauth-refresh',
        expiresAt: Date.now() + 3_600_000,
        requestedScopes: config.scopes,
        grantedScopes: [READ],
        ...extra,
      }),
      { mode: 0o600 },
    )
  }
  const observed = async () =>
    JSON.parse(await fs.readFile(path.join(home, 'observed.json'), 'utf8')) as {
      calls: Array<{ url: string; authorization: string | null }>
      spawns: Array<{
        command: string
        args: string[]
        env: Record<string, string>
        stdio: unknown
      }>
    }

  it('uses the OAuth credential for registry/download and hands off v1 argv without legacy', async () => {
    await fs.writeFile(path.join(home, 'guard.cjs'), OBSERVING_GUARD)
    await seed()
    // A legacy cache entry must not be read or used in OAuth mode.
    await fs.mkdir(path.join(home, '.palantir'), { recursive: true })
    await fs.writeFile(
      path.join(home, '.palantir/mcp-config.json'),
      JSON.stringify({ hosts: { 'https://example.com': { token: 'synthetic-cache' } } }),
    )
    const result = run([...oauthRuntime, '--disable-tools', 'x'])
    expect(result.stderr).not.toContain('FORBIDDEN')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Requested but not granted: palantir-mcp:execute')
    const { calls, spawns } = await observed()
    expect(calls.map((call) => call.authorization)).toEqual([null, 'Bearer synthetic-oauth-access'])
    expect(spawns.map((spawn) => spawn.command)).toEqual(['npx', 'npx'])
    expect(spawns[0].args).toEqual([
      '-y',
      '--package',
      '@palantir/mcp@9.8.7',
      '--',
      'node',
      '--version',
    ])
    expect(spawns[1].stdio).toBe('inherit')
    expect(spawns[1].args).toEqual([
      '-y',
      '--prefer-offline',
      '@palantir/mcp@9.8.7',
      'start',
      'local-development',
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-client-id',
      'fixture',
      '--oauth-redirect',
      'http://127.0.0.1:49152/callback',
      '--oauth-profile',
      'default',
      '--oauth-scopes',
      `offline_access palantir-mcp:execute ${READ}`,
      '--disable-tools',
      'x',
    ])
    for (const spawn of spawns) {
      expect(spawn.env.FOUNDRY_TOKEN).toBeUndefined()
      expect(JSON.stringify(spawn.args)).not.toContain('synthetic-')
      const secrets = Object.entries(spawn.env).filter(([, value]) => value.includes('synthetic-'))
      expect(secrets).toEqual([[expect.stringMatching(/:_authToken$/), 'synthetic-oauth-access']])
    }
    // The OAuth store shares ~/.palantir but never changes the legacy cache next to it.
    expect(
      JSON.parse(await fs.readFile(path.join(home, '.palantir/mcp-config.json'), 'utf8')),
    ).toEqual({
      hosts: { 'https://example.com': { token: 'synthetic-cache' } },
    })
    expect(await legacyCacheEntries()).toEqual(['mcp-config.json'])
  })

  it('shares dedicated defaults between auth status, startup and the explicit core handoff', async () => {
    await seed({}, { oauthClientId: undefined, oauthRedirect: undefined, oauthScopes: undefined })
    const defaultOptions = ['--foundry-api-url', 'https://example.com']
    // Status must find the same binding without network, browser or legacy credential access.
    const status = run(['auth', 'status', ...defaultOptions])
    expect(status.status).toBe(0)
    expect(status.stdout).toBe('')
    expect(status.stderr).toContain('Refresh credential: present')
    expect(status.stderr).toContain('Offline access: granted')
    expect(status.stderr).not.toContain('FORBIDDEN')
    expect(status.stderr).not.toContain('synthetic-')

    await fs.writeFile(path.join(home, 'guard.cjs'), OBSERVING_GUARD)
    const result = run(['--auth=oauth', ...defaultOptions])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('FORBIDDEN')
    const { calls, spawns } = await observed()
    expect(calls.map((call) => call.authorization)).toEqual([null, 'Bearer synthetic-oauth-access'])
    expect(spawns.map((spawn) => spawn.command)).toEqual(['npx', 'npx'])
    expect(spawns[1].args).toEqual([
      '-y',
      '--prefer-offline',
      '@palantir/mcp@9.8.7',
      'start',
      'local-development',
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-client-id',
      'e9036da0035845c988db3a6536f08a42',
      '--oauth-redirect',
      'http://127.0.0.1:49152/oauth2redirect/palantir-mcp',
      '--oauth-profile',
      'default',
      '--oauth-scopes',
      ['offline_access', ...TOOL_PERMISSION_GROUP_NAMES].sort().join(' '),
    ])
    expect(spawns[1].env.FOUNDRY_TOKEN).toBeUndefined()
    expect(await legacyCacheEntries()).toEqual([])
  })

  it('rejects the removed required-scopes option before registry access', async () => {
    await fs.writeFile(path.join(home, 'guard.cjs'), OBSERVING_GUARD)
    await seed({ grantedScopes: ['palantir-mcp:execute'] })
    const result = run([...oauthRuntime, '--oauth-required-scopes', READ])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Unsupported OAuth option')
    expect(result.stderr).not.toContain('FORBIDDEN')
    await expect(fs.stat(path.join(home, 'observed.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('without stored credentials attempts one consent only and never legacy', async () => {
    await fs.writeFile(path.join(home, 'guard.cjs'), OBSERVING_GUARD)
    const result = run(oauthRuntime)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no legacy fallback')
    expect(result.stderr).not.toContain('FORBIDDEN')
    expect(result.stderr).not.toContain('synthetic-env-secret')
    const { calls, spawns } = await observed()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({
      url: 'https://example.com/.well-known/oauth-authorization-server/multipass',
      authorization: null,
    })
    expect(spawns.map((spawn) => spawn.command)).toEqual([
      process.platform === 'darwin' ? 'open' : 'xdg-open',
    ])
    expect(await legacyCacheEntries()).toEqual([])
  })

  it.each([true, false])(
    'auth status reports offline access (%s) and scopes without secrets or network',
    async (issued) => {
      await seed({ refreshToken: issued ? 'synthetic-oauth-refresh' : undefined })
      const result = run([
        'auth',
        'status',
        '--foundry-api-url',
        'https://example.com',
        '--oauth-client-id',
        'fixture',
        '--oauth-redirect',
        'http://127.0.0.1:49152/callback',
        '--oauth-scopes',
        `${READ} palantir-mcp:execute`,
      ])
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(`Reported granted scopes: ${READ}`)
      expect(result.stderr).toContain(
        `Offline access: ${issued ? 'granted' : 'not granted (no refresh token)'}`,
      )
      expect(result.stderr).not.toContain('synthetic-oauth')
      expect(result.stderr).not.toContain('FORBIDDEN')
    },
  )
})
