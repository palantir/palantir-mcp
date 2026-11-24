/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execFile, spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { privateRuntimeArgs } from '../arguments.js'
import { authConfig } from '../config.js'
import { credentialBinding } from '../store.js'
import { oauthMetadata } from './fixtures/oauthMetadata.js'

const exec = promisify(execFile)
let bundleDirectory: string
let bundle: string
beforeAll(async () => {
  bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-bundle-'))
  bundle = path.join(bundleDirectory, 'index.mjs')
  await fs.symlink(path.resolve('node_modules'), path.join(bundleDirectory, 'node_modules'), 'dir')
  await exec(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'bundle', '--', `--outfile=${bundle}`],
    {
      timeout: 30_000,
    },
  )
}, 40_000)
afterAll(async () => {
  await fs.rm(bundleDirectory, { recursive: true, force: true })
})

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-cli-'))
  await fs.writeFile(
    path.join(home, 'guard.cjs'),
    `const fail = () => { process.stderr.write('FORBIDDEN_SIDE_EFFECT'); process.exit(93) };
global.fetch = fail;
const cp = require('node:child_process'); cp.spawn = fail; cp.exec = fail;
require('node:module').syncBuiltinESMExports();`,
  )
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})
const run = (args: string[]) =>
  spawnSync(process.execPath, ['--require', path.join(home, 'guard.cjs'), bundle, ...args], {
    cwd: home,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      FOUNDRY_TOKEN: 'synthetic-env-secret',
    },
  })

describe('built launcher', () => {
  it('rejects auth commands and removed OAuth flags before any network or download', () => {
    const auth = run(['auth', 'status', '--foundry-api-url', 'https://example.com'])
    expect(auth.status).toBe(1)
    expect(auth.stderr).toContain('does not provide auth commands')
    expect(auth.stderr).not.toContain('FORBIDDEN')
    const override = run([
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-client-id',
      'synthetic-input',
    ])
    expect(override.status).toBe(1)
    expect(override.stderr).toContain('--oauth-scopes only')
    expect(override.stderr).not.toContain('synthetic-input')
    expect(override.stderr).not.toContain('FORBIDDEN')
    const token = run([
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--foundry-token',
      'synthetic-argument-secret',
    ])
    expect(token.status).toBe(1)
    expect(token.stderr).toContain('conflicts with --foundry-token')
    expect(token.stderr).not.toContain('synthetic-argument-secret')
  })

  it('preserves one built legacy path', async () => {
    await fs.writeFile(
      path.join(home, 'guard.cjs'),
      `const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
global.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/token/ttl') ? 600 : {}), { headers: { 'Content-Type': 'application/json' } });
cp.spawn = (command, args, options) => {
  fs.writeFileSync(process.env.HOME + '/observed.json', JSON.stringify({ command, args, env: options.env }));
  return new EventEmitter();
};
require('node:module').syncBuiltinESMExports();`,
    )
    const args = [
      '--foundry-api-url',
      'https://example.com',
      '--foundry-token',
      'synthetic-cli',
      '--private-option',
      'value',
    ]
    const result = run(args)
    expect(result.status).toBe(0)
    const observed = JSON.parse(await fs.readFile(path.join(home, 'observed.json'), 'utf8'))
    expect(observed.command).toBe('npx')
    expect(observed.args).toEqual(['-y', '@palantir/mcp@latest', ...args])
    expect(observed.env.FOUNDRY_TOKEN).toBe('synthetic-cli')
    expect(observed.env.NPM_CONFIG_REGISTRY).toContain('/contents/release/npm/')
    expect(Object.entries(observed.env).find(([key]) => key.endsWith(':_authToken'))?.[1]).toBe(
      'synthetic-cli',
    )
  })

  it('starts OAuth from the shared store without legacy credentials or a second download', async () => {
    await fs.writeFile(
      path.join(home, 'guard.cjs'),
      `const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const calls = [];
const spawns = [];
global.fetch = async (url, options) => {
  url = String(url);
  calls.push({ url, authorization: new Headers(options && options.headers).get('Authorization') });
  if (url.includes('/.well-known/')) return new Response(JSON.stringify(${JSON.stringify(oauthMetadata())}));
  if (url.includes('%40palantir%2Fmcp')) return new Response(JSON.stringify({ 'dist-tags': { latest: '9.8.7' } }));
  return new Response('ok');
};
cp.spawn = (command, args, options) => {
  spawns.push({ command, args, env: options.env, stdio: options.stdio });
  fs.writeFileSync(process.env.HOME + '/observed.json', JSON.stringify({ calls, spawns }));
  const child = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => child.emit('exit', command === 'npx' ? 0 : 1, null));
  return child;
};
require('node:module').syncBuiltinESMExports();`,
    )
    const config = authConfig(
      'https://example.com',
      'palantir-mcp:read-metadata palantir-mcp:execute',
    )
    const directory = path.join(home, '.palantir', 'mcp-oauth')
    await fs.mkdir(path.join(home, '.palantir'), { recursive: true, mode: 0o700 })
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(path.join(home, '.palantir', 'mcp-config.json'), '{"hosts":{}}')
    await fs.writeFile(
      path.join(directory, `${credentialBinding(config)}.json`),
      JSON.stringify({
        version: 1,
        binding: credentialBinding(config),
        accessToken: 'synthetic-oauth-access',
        refreshToken: 'synthetic-oauth-refresh',
        expiresAt: Date.now() + 3_600_000,
        requestedScopes: config.scopes,
        grantedScopes: ['palantir-mcp:read-metadata'],
      }),
      { mode: 0o600 },
    )
    const result = run([
      '--auth=oauth',
      '--foundry-api-url',
      'https://example.com',
      '--oauth-scopes',
      'palantir-mcp:read-metadata palantir-mcp:execute',
      '--disable-tools',
      'x',
    ])
    expect(result.status, result.stderr).toBe(0)
    const observed = JSON.parse(await fs.readFile(path.join(home, 'observed.json'), 'utf8'))
    expect(
      observed.calls.map((call: { authorization: string | null }) => call.authorization),
    ).toEqual(['Bearer synthetic-oauth-access'])
    expect(observed.spawns).toHaveLength(1)
    expect(observed.spawns[0].args).toEqual([
      '-y',
      '@palantir/mcp@9.8.7',
      ...privateRuntimeArgs(config, ['--disable-tools', 'x']),
    ])
    expect(observed.spawns[0].args).not.toContain('--prefer-offline')
    expect(observed.spawns[0].env.FOUNDRY_TOKEN).toBeUndefined()
    expect(await fs.readFile(path.join(home, '.palantir', 'mcp-config.json'), 'utf8')).toBe(
      '{"hosts":{}}',
    )
  })

  it('attempts one consent and never falls back when no credential is stored', async () => {
    await fs.writeFile(
      path.join(home, 'guard.cjs'),
      `const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const spawns = [];
global.fetch = async (url) => {
  if (String(url).includes('/.well-known/')) return new Response(JSON.stringify(${JSON.stringify(oauthMetadata())}));
  process.stderr.write('FORBIDDEN_FETCH');
  process.exit(93);
};
cp.spawn = (command, args) => {
  spawns.push(command);
  fs.writeFileSync(process.env.HOME + '/observed.json', JSON.stringify(spawns));
  const child = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => child.emit('exit', 1, null));
  return child;
};
require('node:module').syncBuiltinESMExports();`,
    )
    const result = run(['--auth=oauth', '--foundry-api-url', 'https://example.com'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no legacy fallback')
    expect(result.stderr).not.toContain('FORBIDDEN')
    expect(result.stderr).not.toContain('synthetic-env-secret')
    expect(JSON.parse(await fs.readFile(path.join(home, 'observed.json'), 'utf8'))).toEqual([
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer.exe'
          : 'xdg-open',
    ])
  })
})
