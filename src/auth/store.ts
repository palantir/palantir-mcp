/*
 * Copyright (c) 2026 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileLockError, withFileLock } from '../utils/fileLock.js'
import { OAuthConfig } from './config.js'

/** Version of the protected credential-state schema shared with the private `@palantir/mcp` runtime. */
export const CREDENTIAL_STATE_VERSION = 1
/**
 * Shared directory, relative to the user's home directory: a private subdirectory of the legacy
 * `~/.palantir` folder, whose `mcp-config.json` cache OAuth never reads or writes. Records from
 * earlier unreleased locations are not migrated.
 */
export const CREDENTIAL_STATE_DIRECTORY = path.join('.palantir', 'mcp-oauth')
/** A peer may hold the lock through browser consent (two minutes) and the token exchange. */
export const LOCK_WAIT_MS = 180_000

/**
 * Shared v1 credential state. `grantedScopes` holds operation names reported by the token endpoint:
 * `null` means the response omitted `scope` (unknown, never inferred), `[]` an explicit empty grant.
 */
export interface Credential {
  version: 1
  binding: string
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds. */
  expiresAt: number
  requestedScopes: string[]
  grantedScopes: string[] | null
}

const isScopeList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((scope) => typeof scope === 'string')

export function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false
  const v = value as Credential
  return (
    v.version === CREDENTIAL_STATE_VERSION &&
    typeof v.binding === 'string' &&
    typeof v.accessToken === 'string' &&
    !!v.accessToken &&
    (v.refreshToken === undefined || (typeof v.refreshToken === 'string' && !!v.refreshToken)) &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt) &&
    isScopeList(v.requestedScopes) &&
    (v.grantedScopes === null || isScopeList(v.grantedScopes))
  )
}

/** sha256(UTF-8 JSON [1, host, clientId, profile, sortedUniqueScopes, redirect]) as lowercase hex. */
export function credentialBinding(config: OAuthConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        CREDENTIAL_STATE_VERSION,
        config.host,
        config.clientId,
        config.profile,
        [...new Set(config.scopes)].sort(),
        config.redirect,
      ]),
    )
    .digest('hex')
}

/**
 * Protected v1 store shared with the private runtime under the same HOME. Callers must hold
 * locked() for the entire read/network/write transaction; the lock is never stolen.
 */
export class OAuthStore {
  readonly binding: string
  readonly requestedScopes: string[]
  private readonly file: string
  private readonly lockFile: string
  constructor(
    config: OAuthConfig,
    private readonly directory = path.join(os.homedir(), CREDENTIAL_STATE_DIRECTORY),
    private readonly lockWaitMs = LOCK_WAIT_MS,
  ) {
    this.binding = credentialBinding(config)
    this.requestedScopes = [...new Set(config.scopes)].sort()
    this.file = path.join(directory, `${this.binding}.json`)
    // One permanent lock file per binding, shared with the private runtime.
    this.lockFile = path.join(directory, `${this.binding}.lock`)
  }

  private matches(value: Credential): boolean {
    return (
      value.binding === this.binding &&
      JSON.stringify(value.requestedScopes) === JSON.stringify(this.requestedScopes)
    )
  }

  private async checkPrivate(file: string, directory: boolean): Promise<void> {
    const stat = await fs.lstat(file)
    // Windows has no POSIX owner or mode bits: like the legacy ~/.palantir cache, rely on the user
    // profile's inherited ACL. lstat still reports symbolic links and junctions there.
    const ownerOnly =
      process.platform === 'win32' || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || !ownerOnly) {
      throw new Error('OAuth storage requires current-user ownership and private permissions')
    }
  }

  /**
   * Serializes all access to this binding with the native lock on `<binding>.lock`, the same
   * protocol as the private runtime. Only lock acquisition failures are translated.
   */
  async locked<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let prepared = false
    let acquired = false
    try {
      return await withFileLock(
        this.lockFile,
        () => {
          acquired = true
          return action()
        },
        {
          prepare: async () => {
            try {
              // Creates a missing ~/.palantir with the legacy cache's mode; only mcp-oauth is checked.
              await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
              await this.checkPrivate(this.directory, true)
            } catch {
              throw new Error('OAuth storage directory is unavailable or unsafe')
            }
            prepared = true
          },
          waitTimeoutMs: this.lockWaitMs,
          signal,
        },
      )
    } catch (error) {
      if (acquired || signal?.aborted) throw error
      if (error instanceof FileLockError && error.reason === 'unavailable')
        throw new Error('OAuth storage locking is unavailable; refusing unlocked credential access')
      if (error instanceof FileLockError)
        throw new Error('OAuth storage busy: another process is still authorizing; retry later')
      if (!prepared) throw error
      throw new Error('OAuth lock unavailable')
    }
  }

  async read(): Promise<Credential | undefined> {
    try {
      await this.checkPrivate(this.file, false)
      // O_NOFOLLOW is undefined on Windows; the lstat check above still refuses links there.
      const handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const value: unknown = JSON.parse(await handle.readFile('utf8'))
        if (!isCredential(value) || !this.matches(value)) throw new Error('Invalid record')
        return value
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('OAuth credential record could not be read safely')
    }
  }

  async write(value: Credential): Promise<void> {
    if (!isCredential(value) || !this.matches(value))
      throw new Error('Invalid OAuth credential binding')
    const record: Credential = {
      version: CREDENTIAL_STATE_VERSION,
      requestedScopes: value.requestedScopes,
      grantedScopes: value.grantedScopes,
      binding: value.binding,
      accessToken: value.accessToken,
      ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }),
      expiresAt: value.expiresAt,
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(record))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, this.file)
    } catch {
      throw new Error('OAuth credentials could not be saved; check private storage before retrying')
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  async remove(): Promise<void> {
    await fs.rm(this.file, { force: true })
  }
}
