/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execFile } from 'child_process'
import { cp, mkdtemp, rm, symlink } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, expect, it } from 'vitest'

const exec = promisify(execFile)
let directory: string
let cli: string

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-native-startup-'))
  await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'junction')
  cli = path.join(directory, 'app', 'index.mjs')
  await cp(
    path.resolve('node_modules/fs-native-extensions'),
    path.join(directory, 'app/node_modules/fs-native-extensions'),
    {
      recursive: true,
      dereference: true,
      filter: (source) => path.basename(source) !== 'prebuilds',
    },
  )
  // Build the real entry point using the production command, without sharing
  // mutable dist output with the package-version E2E test.
  await exec(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'bundle', '--', `--outfile=${cli}`],
    {
      timeout: 30_000,
    },
  )
}, 40_000)

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('starts the built wrapper without native lock binaries', async () => {
  const options = {
    cwd: path.dirname(cli),
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    timeout: 5000,
  }
  await expect(
    exec(process.execPath, ['-e', "require('fs-native-extensions')"], options),
  ).rejects.toThrow('Cannot find addon')
  const { stdout } = await exec(process.execPath, [cli, '--help'], options)
  expect(stdout).toContain('Usage:')
})
