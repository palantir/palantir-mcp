/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { exec } from 'child_process'
import crypto from 'crypto'
import { AuthoringApi } from '@api/authoringApi.js'
import { HttpRequestContext } from '@api/httpRequestContext.js'
import { MultipassApi } from '@api/multipassApi.js'
import { AuthenticationTimoutError } from 'src/errors.js'
import { isTokenExpired, retrieveTokenFromSecret } from './authTokenUtils.js'

/**
 * Simple token refresh utilities for LocalDevelopmentConfig
 */
export class TokenRefreshUtils {
  private readonly authoringApi: AuthoringApi
  private readonly multipassApi: MultipassApi
  private static MINIMUM_TOKEN_TTL = 300

  constructor(
    private readonly apiUrl: URL,
    readonly currentToken: string,
  ) {
    const httpRequestContext: HttpRequestContext = { apiUrl, token: currentToken }
    this.authoringApi = new AuthoringApi(httpRequestContext)
    this.multipassApi = new MultipassApi(httpRequestContext)
  }

  /**
   * Forces a token refresh via browser auth, regardless of current token's TTL.
   * @returns Promise that resolves to the new token
   */
  async forceRefreshToken(): Promise<string> {
    const secret = this.generateSecret()
    const authorizationUrl = this.getAuthorizationUrl(secret)

    await this.openBrowser(authorizationUrl)

    const newToken: string = await this.pollForToken(secret)

    return newToken
  }

  /**
   * Checks whether the current token is expired (or expiring within the minimum
   * TTL) without initiating any interactive refresh.
   * @returns true if the token is expired/expiring. Throws InvalidAuthTokenError
   * if the token is not valid for this stack (e.g. signed by a different stack).
   */
  async isExpired(): Promise<boolean> {
    return isTokenExpired(this.multipassApi, TokenRefreshUtils.MINIMUM_TOKEN_TTL)
  }

  private generateSecret(): string {
    return crypto.randomBytes(32).toString('hex')
  }

  private getAuthorizationUrl(secret: string): string {
    const params = new URLSearchParams({
      secret,
      origin: 'palantir-mcp',
    })

    return `https://${this.apiUrl.host}/workspace/data-integration/code/gradle/auth?${params.toString()}`
  }

  private async openBrowser(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let command: string

      switch (process.platform) {
        case 'darwin':
          command = `open "${url}"`
          break
        case 'win32':
          command = `start "" "${url}"`
          break
        default:
          command = `xdg-open "${url}"`
          break
      }

      exec(command, (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  private async pollForToken(secret: string): Promise<string> {
    const timeoutSeconds = 60
    const pollIntervalMs = 1000
    const maxAttempts = timeoutSeconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const token: string | undefined = await retrieveTokenFromSecret(secret, this.authoringApi)

      if (token) {
        return token
      }

      console.error('Waiting for user to authenticate in browser...')

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new AuthenticationTimoutError()
  }
}
