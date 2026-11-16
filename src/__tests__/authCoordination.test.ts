/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execFile } from 'child_process'
import { cp, copyFile, symlink, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const internal = false
let directory: string
let ownBundle: string
let peerBundle: string | undefined

// Stub only external auth/Git/logging boundaries. The production token manager,
// preflight, cache parsing/atomic persistence, and kernel lock are all real.
async function bundle(root: string, server: boolean, name: string) {
  const outfile = path.join(directory, name + '.cjs')
  await build({
    entryPoints: [
      path.join(root, server ? 'src/cli/config/utils/tokenManager.ts' : 'src/preflightChecks.ts'),
    ],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['fs-native-extensions'],
    plugins: [
      {
        name: 'auth-boundaries',
        setup(b) {
          b.onResolve({ filter: /tokenRefreshUtils(?:\.js)?$/ }, () => ({
            path: 'auth',
            namespace: 'stub',
          }))
          b.onResolve({ filter: /gitConfigParser(?:\.js)?$/ }, () => ({
            path: 'git',
            namespace: 'stub',
          }))
          b.onResolve({ filter: /^@foundry\/woodchuck$|RemoteLoggerRegistry(?:\.js)?$/ }, () => ({
            path: 'logging',
            namespace: 'stub',
          }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'git'
                ? "export const parseGitToken = () => 'git.token.sig'; export const parseGitConfig = () => ({token:'git.token.sig'});"
                : args.path === 'logging'
                  ? 'export const SafeArg = {}; export const RemoteLoggerRegistry = {};'
                  : `
          import fs from 'fs';
          import os from 'os';
          import path from 'path';
          export const isValidJwtToken = t => t.split('.').length === 3;
          export class TokenRefreshUtils {
            constructor(url, token) { this.token = token; }
            async isExpired() { return this.isTokenExpired(this.token); }
            async isTokenExpired(token) {
              if (process.env.UNCERTAIN_TTL) throw new Error('TTL unavailable');
              return token.startsWith('old');
            }
            async forceRefreshToken() {
              fs.appendFileSync(path.join(os.homedir(), 'browser.log'), 'browser\\n');
              await new Promise(r => setTimeout(r, 80));
              return 'fresh.browser.sig';
            }
          }
        `,
          }))
        },
      },
    ],
  })
  return outfile
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-auth-production-'))
  await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'junction')
  ownBundle = await bundle(process.cwd(), internal, 'own')
  if (process.env.MCP_AUTH_PEER_ROOT)
    peerBundle = await bundle(process.env.MCP_AUTH_PEER_ROOT, !internal, 'peer')
}, 30_000)
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function home() {
  const h = await mkdtemp(path.join(directory, 'home-'))
  await mkdir(path.join(h, '.palantir'))
  await writeFile(
    path.join(h, '.palantir', 'mcp-config.json'),
    JSON.stringify({
      hosts: {
        'https://example.invalid': { token: 'old.token.sig' },
        'https://other.invalid': { token: 'other.token.sig' },
      },
      extra: 'preserved',
    }),
  )
  return h
}
function run(h: string, file: string, server: boolean, code?: string, extraEnv = {}) {
  const operation =
    code ??
    (server
      ? "const manager = new pkg.TokenManager(url, 'old.cli.sig'); console.log((await manager.refreshTokenIfExpired()) ?? manager.getTokenOrThrow());"
      : "console.log(await pkg.validateFoundryToken(url, 'old.cli.sig'));")
  return exec(
    process.execPath,
    [
      '-e',
      `
    const fs = require('fs'), path = require('path'), pkg = require(${JSON.stringify(file)});
    const cache = path.join(require('os').homedir(), '.palantir', 'mcp-config.json');
    const url = new URL('https://example.invalid');
    (async () => { ${operation} })().catch(e => { console.error(e); process.exitCode = 1; });
  `,
    ],
    {
      env: {
        ...process.env,
        HOME: h,
        USERPROFILE: h,
        NODE_PATH: path.resolve('node_modules'),
        ...extraEnv,
      },
      timeout: 15_000,
    },
  )
}
async function verify(h: string, results: { stdout: string }[]) {
  expect(results.every((r) => r.stdout.trim() === 'fresh.browser.sig')).toBe(true)
  expect(await readFile(path.join(h, 'browser.log'), 'utf8')).toBe('browser\n')
  const saved = JSON.parse(await readFile(path.join(h, '.palantir', 'mcp-config.json'), 'utf8'))
  expect(saved.hosts['https://example.invalid'].token).toBe('fresh.browser.sig')
  expect(saved.hosts['https://other.invalid'].token).toBe('other.token.sig')
  expect(saved.extra).toBe('preserved')
}
describe('production authentication across processes', () => {
  it('uses a valid supplied token without native binaries but refuses unlocked refresh', async () => {
    const fixture = await mkdtemp(path.join(directory, 'missing-addon-'))
    await cp(
      path.resolve('node_modules/fs-native-extensions'),
      path.join(fixture, 'node_modules/fs-native-extensions'),
      {
        recursive: true,
        dereference: true,
        filter: (source) => path.basename(source) !== 'prebuilds',
      },
    )
    const isolated = path.join(fixture, 'preflight.cjs')
    await copyFile(ownBundle, isolated)
    const h = await home()
    const cache = path.join(h, '.palantir', 'mcp-config.json')
    const before = await readFile(cache, 'utf8')
    const result = await run(
      h,
      isolated,
      false,
      "console.log(await pkg.validateFoundryToken(url, 'valid.cli.sig'));",
    )
    expect(result.stdout.trim()).toBe('valid.cli.sig')
    await expect(run(h, isolated, false)).rejects.toThrow(
      'Native token-cache locking is unavailable',
    )
    await expect(readFile(path.join(h, 'browser.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(cache, 'utf8')).toBe(before)
  })

  it('eight processes share one browser flow and persist the result', async () => {
    const h = await home()
    await verify(h, await Promise.all(Array.from({ length: 8 }, () => run(h, ownBundle, internal))))
  }, 20_000)
  it.skipIf(!process.env.MCP_AUTH_PEER_ROOT)(
    'mixed wrapper/server processes use the same kernel lock',
    async () => {
      const h = await home()
      await verify(
        h,
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            i % 2 ? run(h, peerBundle!, !internal) : run(h, ownBundle, internal),
          ),
        ),
      )
    },
    20_000,
  )
  it('does not open the browser or overwrite the cache on uncertain TTL', async () => {
    const h = await home()
    const before = await readFile(path.join(h, '.palantir', 'mcp-config.json'), 'utf8')
    await expect(run(h, ownBundle, internal, undefined, { UNCERTAIN_TTL: '1' })).rejects.toThrow(
      'TTL unavailable',
    )
    await expect(readFile(path.join(h, 'browser.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(h, '.palantir', 'mcp-config.json'), 'utf8')).toBe(before)
  })
  it.skipIf(!internal)(
    'explicit refresh still authenticates after a completed external cache update',
    async () => {
      const h = await home()
      const result = await run(
        h,
        ownBundle,
        true,
        `
      const manager = new pkg.TokenManager(url);
      const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
      cached.hosts[url.origin].token = 'valid.external.sig';
      fs.writeFileSync(cache, JSON.stringify(cached));
      console.log(await manager.forceRefreshToken());
    `,
      )
      await verify(h, [result])
    },
  )
  it.skipIf(internal)('valid supplied token works without a usable cache directory', async () => {
    const h = await home()
    await rm(path.join(h, '.palantir'), { recursive: true })
    await writeFile(path.join(h, '.palantir'), 'not a directory')
    const result = await run(
      h,
      ownBundle,
      false,
      "console.log(await pkg.validateFoundryToken(url, 'valid.cli.sig'));",
    )
    expect(result.stdout.trim()).toBe('valid.cli.sig')
    await expect(readFile(path.join(h, 'browser.log'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
