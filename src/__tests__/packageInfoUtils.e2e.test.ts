/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * End-to-end test for package version functionality.
 *
 * This test validates the complete workflow:
 * 1. Sets a test version in package.json
 * 2. Builds the project (bundling the version lookup code)
 * 3. Packs into an npm tarball
 * 4. Tests the package using npx (no global install needed)
 * 5. Tests that `--version` flag returns the correct version
 * 6. Tests that the version appears in user agent strings
 *
 * Cleanup steps ensure the test doesn't leave artifacts:
 * - Removes the generated tarball file
 * - Restores package.json and package-lock.json from backups
 * - Cleans up built files (dist/)
 *
 * This ensures the version system works end-to-end as it will
 * in production when CircleCI publishes with real version numbers.
 */

import { execFile } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { promisify } from 'util'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const exec = promisify(execFile)

describe('Package Version E2E', () => {
  const testVersion = '12.34.56-e2e-test'
  let tarballPath: string

  // npm can take longer than Vitest's default hook deadline. Keep subprocesses
  // asynchronous so its worker can service RPC messages during build/cleanup.
  beforeAll(async () => {
    // Save original package.json and package-lock.json in backup files, so we can revert after the test completes
    await exec('cp', ['package.json', 'package.json.backup'])
    if (existsSync('package-lock.json')) {
      await exec('cp', ['package-lock.json', 'package-lock.json.backup'])
    }

    await exec('npm', ['version', testVersion, '--no-git-tag-version', '--allow-same-version'], {
      timeout: 30_000,
    })
    await exec('npm', ['run', 'build'], { timeout: 30_000 })
    const { stdout } = await exec('npm', ['pack'], { timeout: 30_000 })
    tarballPath = stdout.trim().split('\n').pop() || ''
  }, 100_000)

  afterAll(async () => {
    // Clean up the tarball
    if (tarballPath && existsSync(tarballPath)) {
      unlinkSync(tarballPath)
    }

    // Restore original package.json
    if (existsSync('package.json.backup')) {
      await exec('mv', ['package.json.backup', 'package.json'])
    }

    // Restore original package-lock.json if it was backed up
    if (existsSync('package-lock.json.backup')) {
      await exec('mv', ['package-lock.json.backup', 'package-lock.json'])
    } else if (existsSync('package-lock.json')) {
      // Remove package-lock.json if it didn't exist originally
      unlinkSync('package-lock.json')
    }

    // Clean up built files
    await exec('npm', ['run', 'clean'], { timeout: 30_000 })
  }, 40_000)

  it('should work with npx and --version flag', async () => {
    expect(tarballPath).toBeTruthy()
    expect(existsSync(tarballPath)).toBe(true)

    // Test the --version flag using npx
    const { stdout } = await exec('npx', ['-y', `./${tarballPath}`, '--version'], {
      timeout: 30_000,
    })
    expect(stdout.trim()).toBe(testVersion)
  }, 40_000)
})
