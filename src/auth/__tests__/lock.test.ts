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
import { authConfig } from '../config.js'
import { OAuthStore } from '../store.js'

const exec = promisify(execFile)
const config = authConfig({ foundryApiUrl: 'https://example.com' })
let directory: string
let store: OAuthStore
let lockFile: string
const children: ChildProcess[] = []
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-lock-'))
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

/**
 * The private runtime's protocol, reduced to its essentials: an exclusive fs-native-extensions
 * lock on `<binding>.lock`, held by another process until it is told to finish or killed.
 */
async function foreignHolder(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const fd = require('fs').openSync(${JSON.stringify(lockFile)}, 'a+', 0o600)
      if (!require('fs-native-extensions').tryLock(fd)) process.exit(2)
      console.log('ready')
      process.once('message', () => process.exit(0))
      `,
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
  )
  children.push(child)
  const [data] = (await once(child.stdout!, 'data')) as [Buffer]
  expect(data.toString()).toBe('ready\n')
  return child
}
/** Whether another process can take the same native lock right now. */
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

describe('native credential lock shared with the private runtime', () => {
  it('waits for a lock held by another process; cancellation is prompt and never steals', async () => {
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

  it('recovers immediately when the holding process is killed', async () => {
    const holder = await foreignHolder()
    let entered = false
    const waiting = store.locked(async () => {
      entered = true
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(entered).toBe(false)
    holder.kill('SIGKILL')
    await once(holder, 'close')
    const started = performance.now()
    await waiting
    expect(entered).toBe(true)
    expect(performance.now() - started).toBeLessThan(1_000)
  }, 15_000)

  it('blocks other processes while the launcher holds the lock', async () => {
    await store.locked(async () => {
      expect(await foreignTryLock()).toBe(false)
    })
    expect(await foreignTryLock()).toBe(true)
  }, 15_000)

  it('refuses instead of falling back when the native addon is unavailable', async () => {
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

  it.each([
    ['missing', undefined],
    ['existing', 0o755],
  ])(
    'defaults to a private ~/.palantir/mcp-oauth beside the legacy cache (%s ~/.palantir)',
    async (_, existingMode) => {
      const palantir = path.join(directory, '.palantir')
      if (existingMode !== undefined) {
        await fs.mkdir(palantir)
        await fs.chmod(palantir, existingMode)
        await fs.writeFile(path.join(palantir, 'mcp-config.json'), 'legacy')
      }
      const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
      process.env.HOME = process.env.USERPROFILE = directory
      let defaultStore: OAuthStore
      try {
        defaultStore = new OAuthStore(config)
      } finally {
        for (const [name, value] of Object.entries(previous))
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
      }
      await defaultStore.locked(async () => {})
      const stored = path.join(palantir, 'mcp-oauth')
      expect(await fs.readdir(stored)).toEqual([`${defaultStore.binding}.lock`])
      expect((await fs.readdir(palantir)).sort()).toEqual(
        existingMode === undefined ? ['mcp-oauth'] : ['mcp-config.json', 'mcp-oauth'],
      )
      if (existingMode !== undefined)
        expect(await fs.readFile(path.join(palantir, 'mcp-config.json'), 'utf8')).toBe('legacy')
      if (process.platform !== 'win32') {
        expect((await fs.stat(palantir)).mode & 0o777).toBe(existingMode ?? 0o700)
        expect((await fs.stat(stored)).mode & 0o777).toBe(0o700)
      }
    },
  )

  it('does not translate errors thrown by the locked action', async () => {
    const failure = new Error('action failed')
    await expect(store.locked(() => Promise.reject(failure))).rejects.toBe(failure)
  })
})
