/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from 'vitest'

import {
  AuthenticationError,
  McpError,
  NetworkError,
  NodeVersionError,
  PackageFetchError,
} from '../errors.js'

describe('errors', () => {
  describe('NodeVersionError', () => {
    it('should create error with correct message', () => {
      const error = new NodeVersionError('16.14.0')
      expect(error.message).toContain('Node.js version 16.14.0 is not supported')
      expect(error.message).toContain('upgrade to Node.js 18 or higher')
      expect(error.name).toBe('NodeVersionError')
    })
  })

  describe('NetworkError', () => {
    it('should create error with URL and cause', () => {
      const url = new URL('https://example.palantirfoundry.com')
      const cause = new Error('Network failure')
      const error = new NetworkError(url, cause)

      expect(error.message).toContain(
        'Unable to reach the Foundry API at https://example.palantirfoundry.com',
      )
      expect(error.message).toContain('VPN, firewall settings')
      expect(error.cause).toBe(cause)
      expect(error.name).toBe('NetworkError')
    })
  })

  describe('AuthenticationError', () => {
    it('should create error with token generation URL', () => {
      const url = new URL('https://example.palantirfoundry.com')
      const error = new AuthenticationError(url)

      expect(error.message).toContain('Unable to authenticate with Foundry API')
      expect(error.message).toContain(
        'https://example.palantirfoundry.com/workspace/settings/tokens',
      )
      expect(error.name).toBe('AuthenticationError')
    })
  })

  describe('PackageFetchError', () => {
    it('should create error with cause', () => {
      const cause = new Error('Fetch failed')
      const error = new PackageFetchError(cause)

      expect(error.message).toContain('Unable to fetch the Palantir MCP package')
      expect(error.message).toContain('contact Foundry support')
      expect(error.cause).toBe(cause)
      expect(error.name).toBe('PackageFetchError')
    })
  })

  describe('McpError', () => {
    it('should be the base error class', () => {
      const error = new McpError('Test error')
      expect(error.message).toBe('Test error')
      expect(error.name).toBe('McpError')
    })
  })
})
