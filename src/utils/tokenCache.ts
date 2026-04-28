/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const CONFIG_DIR = path.join(os.homedir(), '.palantir')
const CONFIG_FILE = path.join(CONFIG_DIR, 'mcp-config.json')

interface HostEntry {
  token: string
  [key: string]: unknown
}

interface PalantirMcpConfig {
  hosts: Record<string, HostEntry>
  [key: string]: unknown
}

function loadConfig(): PalantirMcpConfig | undefined {
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8')
    const config = JSON.parse(content)
    if (config && typeof config.hosts === 'object') {
      return config as PalantirMcpConfig
    }
    return undefined
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    console.error(`Failed to load config from ${CONFIG_FILE}:`, error)
    return undefined
  }
}

function restrictToCurrentUserWindows(targetPath: string): void {
  if (process.platform !== 'win32') {
    return
  }
  try {
    // Remove inherited permissions, then grant full control only to the current user
    execSync(`icacls "${targetPath}" /inheritance:r /grant:r "%USERNAME%:F"`, {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    // Best-effort
    console.warn(
      `Failed to restrict file permissions to current user for "${targetPath}".` +
        ` The file may be accessible to other users on this system.`,
      error,
    )
  }
}

// Write to a temporary file, then rename.
function saveConfig(config: PalantirMcpConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  restrictToCurrentUserWindows(CONFIG_DIR)
  const tmpFile = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmpFile, CONFIG_FILE)
  restrictToCurrentUserWindows(CONFIG_FILE)
}

function loadOrCreateConfig(): PalantirMcpConfig {
  return loadConfig() ?? { hosts: {} }
}

export function loadCachedToken(foundryHost: string): string | undefined {
  const config = loadConfig()
  return config?.hosts[foundryHost]?.token || undefined
}

// Creates .palantir directory containing mcp-config.json if they don't exist.
export function saveCachedToken(foundryHost: string, token: string): void {
  try {
    const config = loadOrCreateConfig()
    config.hosts[foundryHost] = { ...config.hosts[foundryHost], token }
    saveConfig(config)
  } catch (error: unknown) {
    console.error('Failed to save token to cache:', error)
  }
}
