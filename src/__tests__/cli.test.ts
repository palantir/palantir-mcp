/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { InvalidArgumentError } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseArguments, parseUrl } from '../command.js'

describe('CLI', () => {
  describe('parseUrl', () => {
    it('should parse valid URLs', () => {
      const url = parseUrl('https://example.palantirfoundry.com')
      expect(url.toString()).toBe('https://example.palantirfoundry.com/')
    })

    it('should throw InvalidArgumentError for invalid URLs', () => {
      expect(() => parseUrl('not-a-url')).toThrow(InvalidArgumentError)
    })
  })

  describe('parseArguments', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      delete process.env.FOUNDRY_TOKEN
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should parse command line arguments', () => {
      const argv = [
        'node',
        'cli.js',
        '--foundry-api-url',
        'https://example.palantirfoundry.com',
        '--foundry-token',
        'test-token-123',
      ]

      const options = parseArguments(argv)

      expect(options.foundryApiUrl.toString()).toBe('https://example.palantirfoundry.com/')
      expect(options.foundryToken).toBe('test-token-123')
    })

    it('should use FOUNDRY_TOKEN environment variable as fallback', () => {
      process.env.FOUNDRY_TOKEN = 'env-token-456'
      const argv = ['node', 'cli.js', '--foundry-api-url', 'https://example.palantirfoundry.com']

      const options = parseArguments(argv)

      expect(options.foundryToken).toBe('env-token-456')
    })

    it('should prefer CLI token over environment variable', () => {
      process.env.FOUNDRY_TOKEN = 'env-token-456'
      const argv = [
        'node',
        'cli.js',
        '--foundry-api-url',
        'https://example.palantirfoundry.com',
        '--foundry-token',
        'cli-token-789',
      ]

      const options = parseArguments(argv)

      expect(options.foundryToken).toBe('cli-token-789')
    })

    it('should throw when --foundry-api-url is missing', () => {
      expect(() => parseArguments(['node', 'cli.js'])).toThrow()
    })

    it('should allow --foundry-token to be omitted', () => {
      const argv = ['node', 'cli.js', '--foundry-api-url', 'https://example.palantirfoundry.com']

      const options = parseArguments(argv)

      expect(options.foundryApiUrl.toString()).toBe('https://example.palantirfoundry.com/')
      expect(options.foundryToken).toBeUndefined()
    })
  })
})
