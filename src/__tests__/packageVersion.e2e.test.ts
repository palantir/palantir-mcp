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
 * 4. Installs the package globally
 * 5. Tests that `--version` flag returns the correct version
 * 6. Tests that the version appears in user agent strings
 *
 * Cleanup steps ensure the test doesn't leave artifacts:
 * - Uninstalls the globally installed test package
 * - Removes the generated tarball file
 * - Restores the original package.json version
 * - Cleans up built files (dist/)
 *
 * This ensures the version system works end-to-end as it will
 * in production when CircleCI publishes with real version numbers.
 */

import { execSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

describe('Package Version E2E', () => {
  const testVersion = '7.7.7-e2e-test'
  let originalPackageJson: string
  let tarballPath: string
  let wasGloballyInstalled = false

  beforeAll(() => {
    // Save original package.json version
    try {
      const pkg = JSON.parse(
        execSync('node -p "JSON.stringify(require(\'./package.json\'))"', {
          encoding: 'utf8',
        }),
      )
      originalPackageJson = pkg.version ? JSON.stringify(pkg.version) : 'null'
    } catch {
      originalPackageJson = 'null'
    }

    // Save original package-lock.json if it exists
    if (existsSync('package-lock.json')) {
      execSync('cp package-lock.json package-lock.json.backup', { stdio: 'pipe' })
    }

    // Set test version
    execSync(`npm version ${testVersion} --no-git-tag-version --allow-same-version`, {
      stdio: 'pipe',
    })

    // Build the package
    execSync('npm run build', { stdio: 'pipe' })

    // Pack the package
    const packOutput = execSync('npm pack', { encoding: 'utf8', stdio: 'pipe' })
    tarballPath = packOutput.trim().split('\n').pop() || ''
  })

  afterAll(() => {
    // Uninstall globally installed package if we installed it
    if (wasGloballyInstalled) {
      try {
        execSync('npm uninstall -g palantir-mcp', { stdio: 'pipe' })
      } catch {
        // Ignore errors - package might not be installed
      }
    }

    // Clean up the tarball
    if (tarballPath && existsSync(tarballPath)) {
      unlinkSync(tarballPath)
    }

    // Restore original package.json version
    if (originalPackageJson !== 'null') {
      const version = JSON.parse(originalPackageJson)
      execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, {
        stdio: 'pipe',
      })
    } else {
      // Remove version if it didn't exist originally
      execSync(
        "node -e \"const pkg = require('./package.json'); delete pkg.version; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n')\"",
        { stdio: 'pipe' },
      )
    }

    // Restore original package-lock.json if it was backed up
    if (existsSync('package-lock.json.backup')) {
      execSync('mv package-lock.json.backup package-lock.json', { stdio: 'pipe' })
    } else if (existsSync('package-lock.json')) {
      // Remove package-lock.json if it didn't exist originally
      unlinkSync('package-lock.json')
    }

    // Clean up built files
    execSync('npm run clean', { stdio: 'pipe' })
  })

  it('should work with global npm install and --version flag', () => {
    expect(tarballPath).toBeTruthy()
    expect(existsSync(tarballPath)).toBe(true)

    // Install the package globally
    execSync(`npm install -g ./${tarballPath}`, { stdio: 'pipe' })
    wasGloballyInstalled = true

    try {
      // Test the --version flag
      const versionOutput = execSync('palantir-mcp --version', { encoding: 'utf8' }).trim()
      expect(versionOutput).toBe(testVersion)

      // Test that it also shows the version in the user agent when making requests
      // This will fail early due to network issues, but should show the version in logs
      const fullOutput = execSync(
        'palantir-mcp --foundry-api-url https://test.com --foundry-token dummy 2>&1 || true',
        { encoding: 'utf8' },
      )

      // Should contain our test version in the package version output from the CLI
      expect(fullOutput).toContain(`package verson: ${testVersion}`)
    } finally {
      // Test cleanup happens in afterAll
    }
  })
})
