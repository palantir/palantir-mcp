/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export function getPackageVersion(): string {
  try {
    // Get the current file's directory in ES modules
    const __filename = fileURLToPath(import.meta.url)
    let currentDir = dirname(__filename)

    // Walk up directories to find package.json
    for (let i = 0; i < 5; i++) {
      try {
        const packagePath = join(currentDir, 'package.json')
        const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
        if (pkg.version) {
          return pkg.version
        }
      } catch {
        // Continue searching
      }
      currentDir = dirname(currentDir)
    }

    return '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
}
