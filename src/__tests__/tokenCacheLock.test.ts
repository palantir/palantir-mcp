/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execFile, spawn } from 'child_process'
import { once } from 'events'
import {
  cp,
  copyFile,
  symlink,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'fs/promises'
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
  await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'junction')
  bundle = path.join(directory, 'lock.cjs')
  await build({
    entryPoints: [path.resolve('src/utils/tokenCacheLock.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['fs-native-extensions'],
  })
}, 30_000)
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function env(home: string) {
  return { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: path.resolve('node_modules') }
}
function script(code: string) {
  return `
    const { withTokenCacheLock } = require(${JSON.stringify(bundle)});
    const fs = require('fs/promises');
    const cache = require('path').join(require('os').homedir(), '.palantir', 'mcp-config.json');
    (async () => { ${code} })().catch(error => { console.error(error); process.exitCode = 1; });
  `
}
function run(home: string, code: string) {
  return exec(process.execPath, ['-e', script(code)], { env: env(home), timeout: 15_000 })
}
async function home() {
  return mkdtemp(path.join(directory, 'home-'))
}

describe('kernel token cache lock', () => {
  it('loads without native binaries but refuses to run an unlocked operation', async () => {
    const fixture = await mkdtemp(path.join(directory, 'missing-addon-'))
    const addon = path.join(fixture, 'node_modules', 'fs-native-extensions')
    await cp(path.resolve('node_modules/fs-native-extensions'), addon, {
      recursive: true,
      dereference: true,
      // cspell:ignore prebuilds
      filter: (source) => path.basename(source) !== 'prebuilds',
    })
    const isolated = path.join(fixture, 'lock.cjs')
    await copyFile(bundle, isolated)
    const h = await home()
    const result = exec(
      process.execPath,
      [
        '-e',
        `
            const { withTokenCacheLock } = require(${JSON.stringify(isolated)});
            console.log("loaded");
            withTokenCacheLock(async () => console.log("unsafe"))
                .catch(error => { console.error(error); process.exitCode = 1; });
        `,
      ],
      { env: env(h), timeout: 5000 },
    )
    await expect(result).rejects.toMatchObject({
      stdout: 'loaded\n',
      stderr: expect.stringContaining('Native token-cache locking is unavailable'),
    })
    await expect(stat(path.join(h, '.palantir'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes processes and preserves updates for different hosts', async () => {
    const h = await home()
    await mkdir(path.join(h, '.palantir'))
    const cache = path.join(h, '.palantir', 'mcp-config.json')
    await writeFile(cache, JSON.stringify({ hosts: {}, extra: 'preserved' }))
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(
          h,
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

  it('serializes separate descriptors in the same process', async () => {
    const result = await run(
      await home(),
      `
      let inside = 0, max = 0;
      await Promise.all(Array.from({length: 4}, () => withTokenCacheLock(async () => {
        max = Math.max(max, ++inside);
        await new Promise(r => setTimeout(r, 20));
        inside--;
      })));
      console.log(max);
    `,
    )
    expect(result.stdout.trim()).toBe('1')
  })

  it('releases after failure without unlinking or replacing the lock file', async () => {
    const h = await home()
    await expect(
      run(h, "await withTokenCacheLock(async () => { throw new Error('auth failed'); });"),
    ).rejects.toThrow('auth failed')
    const file = path.join(h, '.palantir', 'mcp-config.json.lock')
    const before = await stat(file)
    await run(h, 'await withTokenCacheLock(async () => {});')
    expect((await stat(file)).ino).toBe(before.ino)
  })

  it('recovers immediately after SIGKILL, with no stale timeout', async () => {
    const h = await home()
    await expect(
      run(h, "await withTokenCacheLock(async () => process.kill(process.pid, 'SIGKILL'));"),
    ).rejects.toThrow()
    await expect(
      run(h, "await withTokenCacheLock(async () => console.log('recovered'), 1000);"),
    ).resolves.toMatchObject({ stdout: 'recovered\n' })
  })

  it.skipIf(process.platform === 'win32')(
    'never steals a stopped live owner, even with an ancient mtime',
    async () => {
      const h = await home()
      const holder = spawn(
        process.execPath,
        [
          '-e',
          script(`
      // Isolate ownership from the separate 90-second auth deadline tested below.
      const schedule = global.setTimeout;
      global.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 90000 ? 300000 : ms, ...args);
      await withTokenCacheLock(async () => {
        console.log('ready');
        await new Promise(resolve => process.once('message', resolve));
        await fs.writeFile(cache, 'holder');
      });
      process.disconnect();
    `),
        ],
        { env: env(h), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      )
      const closed = once(holder, 'close')
      try {
        await once(holder.stdout!, 'data')
        holder.kill('SIGSTOP')
        if (process.env.MCP_AUTH_LONG_SUSPEND === '1')
          await new Promise((resolve) => setTimeout(resolve, 123_000))
        const file = path.join(h, '.palantir', 'mcp-config.json.lock')
        const old = new Date(0)
        await utimes(file, old, old)
        await expect(
          run(h, "await withTokenCacheLock(async () => console.log('stolen'), 300);"),
        ).rejects.toMatchObject({ stdout: '' })
        holder.send('finish')
        holder.kill('SIGCONT')
        expect((await closed)[0]).toBe(0)
        expect(await readFile(path.join(h, '.palantir', 'mcp-config.json'), 'utf8')).toBe('holder')
        await expect(
          run(h, "await withTokenCacheLock(async () => console.log('next'), 1000);"),
        ).resolves.toMatchObject({ stdout: 'next\n' })
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
        await closed
      }
    },
    process.env.MCP_AUTH_LONG_SUSPEND === '1' ? 150_000 : 15_000,
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails fast on permission errors',
    async () => {
      const h = await home()
      const dir = path.join(h, '.palantir')
      await mkdir(dir)
      await chmod(dir, 0o500)
      try {
        await expect(
          run(h, "await withTokenCacheLock(async () => console.log('browser'));"),
        ).rejects.toMatchObject({ stdout: '', killed: false })
      } finally {
        await chmod(dir, 0o700)
      }
    },
    5000,
  )

  it('aborts timed-out operations but holds ownership until they stop', async () => {
    const result = await run(
      await home(),
      `
      const original = global.setTimeout;
      global.setTimeout = (fn, ms, ...args) => original(fn, ms === 90000 ? 30 : ms, ...args);
      let aborted = false, waiterEntered = false, entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const operation = withTokenCacheLock(async signal => {
        entered();
        await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
        aborted = signal.aborted;
        await new Promise(r => original(r, 150));
        if (waiterEntered) throw new Error('released before callback stopped');
      });
      const rejected = operation.catch(e => e.message);
      await ready;
      await withTokenCacheLock(async () => { waiterEntered = true; });
      console.log(JSON.stringify({aborted, waiterEntered, error: await rejected}));
    `,
    )
    expect(JSON.parse(result.stdout)).toEqual({
      aborted: true,
      waiterEntered: true,
      error: 'MCP authentication timed out',
    })
  })
})
