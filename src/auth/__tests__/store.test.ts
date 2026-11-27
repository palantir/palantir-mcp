/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authConfig, OAuthConfig } from '../config.js'
import { credentialBinding, Credential, OAuthStore } from '../store.js'
import { SHARED_CREDENTIAL_JSON } from './fixtures/sharedCredential.js'

const exec = promisify(execFile)
const config = authConfig('https://example.com')
let directory: string
let store: OAuthStore
let lockFile: string
const children: ChildProcess[] = []
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-store-'))
  store = new OAuthStore(config, directory)
  lockFile = path.join(directory, `${store.binding}.lock`)
})
afterEach(async () => {
  vi.doUnmock('fs-native-extensions')
  vi.resetModules()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'close')
    }
  }
  await fs.rm(directory, { recursive: true, force: true })
})

async function foreignHolder(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fd = require('fs').openSync(${JSON.stringify(lockFile)}, 'a+', 0o600)
       if (!require('fs-native-extensions').tryLock(fd)) process.exit(2)
       console.log('ready')
       process.once('message', () => process.exit(0))`,
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
  )
  children.push(child)
  const [data] = (await once(child.stdout!, 'data')) as [Buffer]
  expect(data.toString()).toBe('ready\n')
  return child
}
async function foreignTryLock(): Promise<boolean> {
  const { stdout } = await exec(
    process.execPath,
    [
      '-e',
      `const fd = require('fs').openSync(${JSON.stringify(lockFile)}, 'a+', 0o600)
       console.log(require('fs-native-extensions').tryLock(fd))`,
    ],
    { cwd: process.cwd(), timeout: 10_000 },
  )
  return stdout.trim() === 'true'
}

describe('native credential lock', () => {
  it('waits, cancels, and never steals a lock held by another process', async () => {
    await store.locked(async () => {})
    const { ino } = await fs.stat(lockFile)
    const holder = await foreignHolder()
    const action = vi.fn()
    const started = performance.now()
    await expect(store.locked(action, AbortSignal.timeout(300))).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(performance.now() - started).toBeLessThan(2_000)
    await expect(new OAuthStore(config, directory, 300).locked(action)).rejects.toThrow('busy')
    expect(action).not.toHaveBeenCalled()
    holder.send('finish')
    await once(holder, 'close')
    await store.locked(action)
    expect(action).toHaveBeenCalledOnce()
    expect((await fs.stat(lockFile)).ino).toBe(ino)
  }, 15_000)

  it('blocks another process while this process holds the lock', async () => {
    await store.locked(async () => {
      expect(await foreignTryLock()).toBe(false)
    })
    expect(await foreignTryLock()).toBe(true)
  }, 15_000)

  it('refuses unlocked access when the native addon is missing', async () => {
    vi.doMock('fs-native-extensions', () => {
      throw new Error('Cannot find addon')
    })
    vi.resetModules()
    const { OAuthStore: Store } = await import('../store.js')
    const missing = path.join(directory, 'missing')
    const action = vi.fn()
    await expect(new Store(config, missing).locked(action)).rejects.toThrow(
      'OAuth storage locking is unavailable; refusing unlocked credential access',
    )
    expect(action).not.toHaveBeenCalled()
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not relabel an action failure as a lock failure', async () => {
    const failure = new Error('action failed')
    await expect(store.locked(() => Promise.reject(failure))).rejects.toBe(failure)
  })
})

describe('v1 credential record shared with the private runtime', () => {
  const BINDING = 'ec10b4f1c38bdf668f7e18b0e8c042e96de3c7713eb3684d3c60f8a3aadb89ce'
  const custom: OAuthConfig = {
    host: 'https://example.com',
    clientId: 'fixture',
    redirect: 'http://127.0.0.1:49152/callback',
    profile: 'default',
    scopes: ['offline_access', 'palantir-mcp:execute', 'palantir-mcp:read-metadata'],
  }
  it('pins binding digests and round-trips the private runtime record', async () => {
    expect(credentialBinding(config)).toBe(BINDING)
    expect(credentialBinding(custom)).toBe(
      '396a7b9a2612552d3bba8da39d6713aaa03a49914760dd93e2d9536aa59b3397',
    )
    const shared = new OAuthStore(config, directory)
    await fs.writeFile(path.join(directory, `${BINDING}.json`), SHARED_CREDENTIAL_JSON, {
      mode: 0o600,
    })
    expect(await shared.read()).toEqual(JSON.parse(SHARED_CREDENTIAL_JSON))
    await shared.locked(() => shared.write(JSON.parse(SHARED_CREDENTIAL_JSON) as Credential))
    expect(await fs.readFile(path.join(directory, `${BINDING}.json`), 'utf8')).toBe(
      SHARED_CREDENTIAL_JSON,
    )
  })

  it('writes the v1 field order, private modes, and permanent lock file', async () => {
    const shared = new OAuthStore(custom, directory)
    const value: Credential = {
      version: 1,
      requestedScopes: custom.scopes,
      grantedScopes: ['palantir-mcp:read-metadata'],
      binding: shared.binding,
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: 1_700_000_000_000,
    }
    await shared.locked(() => shared.write(value))
    const file = path.join(directory, `${shared.binding}.json`)
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')))).toEqual([
      'version',
      'requestedScopes',
      'grantedScopes',
      'binding',
      'accessToken',
      'refreshToken',
      'expiresAt',
    ])
    expect(await fs.readdir(directory)).toEqual(
      expect.arrayContaining([`${shared.binding}.lock`, `${shared.binding}.json`]),
    )
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    }
  })

  it('reads an unreported grant without a refresh token and rejects other shapes', async () => {
    const shared = new OAuthStore(custom, directory)
    await fs.chmod(directory, 0o700)
    const produced = {
      version: 1,
      requestedScopes: custom.scopes,
      grantedScopes: null,
      binding: shared.binding,
      accessToken: 'A',
      expiresAt: 1,
    }
    const file = path.join(directory, `${shared.binding}.json`)
    await fs.writeFile(file, JSON.stringify(produced), { mode: 0o600 })
    expect(await shared.read()).toEqual(produced)
    await fs.writeFile(file, JSON.stringify({ ...produced, version: 2 }), { mode: 0o600 })
    await expect(shared.read()).rejects.toThrow('could not be read safely')
  })

  it.skipIf(process.platform === 'win32')('refuses unsafe permissions and symlinks', async () => {
    const file = path.join(directory, `${store.binding}.json`)
    await store.locked(() =>
      store.write({
        version: 1,
        binding: store.binding,
        accessToken: 'A',
        expiresAt: 1,
        requestedScopes: config.scopes,
        grantedScopes: [],
      }),
    )
    await fs.chmod(file, 0o644)
    await expect(store.read()).rejects.toThrow('safely')
    await fs.rm(file)
    await fs.symlink('/not-a-real-secret-file', file)
    await expect(store.read()).rejects.toThrow('safely')
    await fs.chmod(directory, 0o755)
    await expect(store.locked(async () => {})).rejects.toThrow('unsafe')
  })
})
