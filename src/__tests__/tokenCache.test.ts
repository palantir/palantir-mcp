/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import fs from 'fs'
import os from 'os'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadCachedToken, saveCachedToken } from '../utils/tokenCache.js'

vi.mock('fs')
vi.mock('os', () => ({
  default: { homedir: vi.fn().mockReturnValue('/mock/home') },
  homedir: vi.fn().mockReturnValue('/mock/home'),
}))

const CACHED_TOKEN = 'cached-host-token'

const VALID_CONFIG = JSON.stringify({
  hosts: {
    'https://example.palantirfoundry.com': {
      token: CACHED_TOKEN,
    },
  },
})

describe('tokenCache', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(os.homedir).mockReturnValue('/mock/home')
  })

  describe('loadCachedToken', () => {
    it('should return undefined when config file does not exist', () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory')
      })

      expect(loadCachedToken('https://example.palantirfoundry.com')).toBeUndefined()
    })

    it('should return the token when host exists', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_CONFIG)

      expect(loadCachedToken('https://example.palantirfoundry.com')).toBe(CACHED_TOKEN)
    })

    it('should return undefined when host is not in config', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_CONFIG)

      expect(loadCachedToken('https://other-host.palantirfoundry.com')).toBeUndefined()
    })

    it('should return undefined for malformed JSON', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue('not valid json{{{')

      expect(loadCachedToken('https://example.palantirfoundry.com')).toBeUndefined()
    })
  })

  describe('saveCachedToken', () => {
    let writtenContent: string

    beforeEach(() => {
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
      vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, content) => {
        writtenContent = content as string
      })
      vi.spyOn(fs, 'renameSync').mockReturnValue(undefined)
    })

    it('should create a new config when none exists', () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT')
      })

      saveCachedToken('https://example.palantirfoundry.com', 'new-token')

      const saved = JSON.parse(writtenContent)
      expect(saved.hosts['https://example.palantirfoundry.com'].token).toBe('new-token')
    })

    it('should merge into existing config without losing other hosts', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_CONFIG)

      saveCachedToken('https://other.palantirfoundry.com', 'other-token')

      const saved = JSON.parse(writtenContent)
      expect(saved.hosts['https://example.palantirfoundry.com'].token).toBe(CACHED_TOKEN)
      expect(saved.hosts['https://other.palantirfoundry.com'].token).toBe('other-token')
    })

    it('should overwrite token for an existing host', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_CONFIG)

      saveCachedToken('https://example.palantirfoundry.com', 'refreshed-token')

      const saved = JSON.parse(writtenContent)
      expect(saved.hosts['https://example.palantirfoundry.com'].token).toBe('refreshed-token')
    })
  })
})
