/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execFile } from 'child_process'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
let directory: string
let bundle: string

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-auth-lock-'))
  bundle = path.join(directory, 'lock.cjs')
  await build({
    entryPoints: [path.resolve('src/utils/tokenCacheLock.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  })
}, 30_000)

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function run(home: string, code: string) {
  return exec(
    process.execPath,
    [
      '-e',
      `
    const { withTokenCacheLock } = require(${JSON.stringify(bundle)});
    const fs = require('fs/promises');
    const cache = require('path').join(require('os').homedir(), '.palantir', 'mcp-config.json');
    (async () => { ${code} })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 15_000 },
  )
}

describe('cross-process token cache lock', () => {
  it('allows only one simulated browser refresh per host and preserves other hosts', async () => {
    const home = await mkdtemp(path.join(directory, 'concurrent-'))
    await mkdir(path.join(home, '.palantir'))
    const cache = path.join(home, '.palantir', 'mcp-config.json')
    await writeFile(cache, JSON.stringify({ hosts: {}, extra: 'preserved' }))
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(
          home,
          `
      await withTokenCacheLock(async () => {
        const config = JSON.parse(await fs.readFile(cache, 'utf8'));
        const host = 'host-${i % 2}';
        if (!config.hosts[host]) {
          console.log('browser');
          await new Promise(resolve => setTimeout(resolve, 50));
          config.hosts[host] = { token: 'fresh' };
          await fs.writeFile(cache, JSON.stringify(config));
        }
      });
    `,
        ),
      ),
    )
    expect(results.filter((result) => result.stdout.includes('browser'))).toHaveLength(2)
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual({
      hosts: { 'host-0': { token: 'fresh' }, 'host-1': { token: 'fresh' } },
      extra: 'preserved',
    })
  }, 20_000)

  it('releases the lock when authentication throws', async () => {
    const home = await mkdtemp(path.join(directory, 'failure-'))
    await expect(
      run(home, "await withTokenCacheLock(async () => { throw new Error('auth failed'); });"),
    ).rejects.toThrow('auth failed')
    await expect(
      run(home, "await withTokenCacheLock(async () => console.log('recovered'));"),
    ).resolves.toMatchObject({ stdout: 'recovered\n' })
  })

  it('recovers a stale lock left by a terminated process', async () => {
    const home = await mkdtemp(path.join(directory, 'stale-'))
    // Exit without releasing: no shutdown hooks or finally blocks execute.
    await expect(
      run(home, `await withTokenCacheLock(async () => process.kill(process.pid, 'SIGKILL'));`),
    ).rejects.toThrow()
    const lock = path.join(home, '.palantir', 'mcp-config.json.lock')
    // Simulate the two-minute stale interval without slowing the suite down.
    const old = new Date(Date.now() - 125_000)
    await utimes(lock, old, old)
    await expect(
      run(home, "await withTokenCacheLock(async () => console.log('recovered'));"),
    ).resolves.toMatchObject({ stdout: 'recovered\n' })
  })

  it('does not run authentication if the lock directory is inaccessible', async () => {
    const home = await mkdtemp(path.join(directory, 'inaccessible-'))
    await writeFile(path.join(home, '.palantir'), 'not a directory')
    await expect(
      run(home, "await withTokenCacheLock(async () => console.log('browser'));"),
    ).rejects.toMatchObject({ stdout: '' })
  })
})
