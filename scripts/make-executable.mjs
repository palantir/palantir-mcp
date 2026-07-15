/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { chmodSync } from 'fs'

if (process.platform !== 'win32') {
  chmodSync('dist/index.js', 0o755)
}
