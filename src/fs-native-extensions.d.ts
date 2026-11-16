/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

declare module 'fs-native-extensions' {
  export function tryLock(fd: number): boolean
}
