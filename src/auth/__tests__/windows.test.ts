/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBrowser } from '../client.js'
import { authConfig } from '../config.js'
import { killProcessGroup } from '../runtime.js'
import { Credential, OAuthStore } from '../store.js'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

// No Windows CI runs this package: these tests emulate win32 on the host for the platform branches.
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')!
const config = authConfig({ foundryApiUrl: 'https://example.com' })
let root: string
// Load the host's native lock binary before emulating win32, which would select the Windows prebuild.
beforeAll(() => import('fs-native-extensions'))
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-win32-'))
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'getuid', getuid)
  vi.mocked(spawn).mockReset()
  await fs.rm(root, { recursive: true, force: true })
})

const fakeChild = () => new EventEmitter() as ChildProcess

describe('OAuth on Windows', () => {
  it('ignores POSIX mode and owner bits and replaces existing credentials atomically', async () => {
    const directory = path.join(root, 'store')
    const store = new OAuthStore(config, directory)
    const record: Credential = {
      version: 1,
      binding: store.binding,
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: 0,
      requestedScopes: config.scopes,
      grantedScopes: null,
    }
    await store.locked(() => store.write(record))
    await fs.chmod(directory, 0o777)
    await fs.chmod(path.join(directory, `${store.binding}.json`), 0o666)
    await store.locked(() => store.write({ ...record, accessToken: 'replaced' }))
    expect(await store.locked(() => store.read())).toMatchObject({ accessToken: 'replaced' })
    expect((await fs.readdir(directory)).sort()).toEqual([
      `${store.binding}.json`,
      `${store.binding}.lock`,
    ])
  })

  it('still refuses linked storage directories and credential files', async () => {
    const directory = path.join(root, 'store')
    const store = new OAuthStore(config, directory)
    await store.locked(async () => {})
    const target = path.join(root, 'elsewhere.json')
    await fs.writeFile(target, '{}')
    await fs.symlink(target, path.join(directory, `${store.binding}.json`), 'file')
    await expect(store.read()).rejects.toThrow('safely')
    const linked = path.join(root, 'linked')
    await fs.symlink(directory, linked, 'junction')
    await expect(new OAuthStore(config, linked).locked(async () => {})).rejects.toThrow('unsafe')
  })

  it('opens the browser with explorer.exe without a shell and accepts its nonzero exit', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child)
    const url = 'https://example.com/authorize?a=1&b=%20'
    const opened = openBrowser(url)
    child.emit('exit', 1)
    await expect(opened).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledExactlyOnceWith('explorer.exe', [url], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    })
    const failing = fakeChild()
    vi.mocked(spawn).mockReturnValue(failing)
    const failed = openBrowser(url)
    failing.emit('error', new Error('ENOENT'))
    await expect(failed).rejects.toThrow('Could not open OAuth browser')
  })

  it('terminates the download process tree with taskkill', () => {
    vi.mocked(spawn).mockReturnValue(fakeChild())
    const child = { pid: 4242, kill: vi.fn() } as unknown as ChildProcess
    killProcessGroup(child, 'SIGTERM')
    expect(spawn).toHaveBeenCalledExactlyOnceWith('taskkill', ['/pid', '4242', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    expect(child.kill).not.toHaveBeenCalled()
  })
})
