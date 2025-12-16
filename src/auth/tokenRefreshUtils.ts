/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { exec } from 'child_process'
import crypto from 'crypto'
import { AuthoringApi } from '@api/authoringApi.js'
import { MultipassApi } from '@api/multipassApi.js'

/**
 * Simple token refresh utilities for LocalDevelopmentConfig
 */
export class TokenRefreshUtils {
  private readonly foundryApiUrl: URL
  private readonly authoringApi: AuthoringApi
  private readonly multipassApi: MultipassApi
  private readonly repositoryRid: string | undefined

  private static MINIMUM_TOKEN_TTL = 300

  constructor(foundryApiUrl: URL, repositoryRid?: string) {
    this.foundryApiUrl = foundryApiUrl
    this.repositoryRid = repositoryRid
    this.authoringApi = new AuthoringApi(foundryApiUrl.host)
    this.multipassApi = new MultipassApi(foundryApiUrl.host)
  }

  /**
   * Attempts to refresh the token interactively
   * @returns Promise that resolves to the new token, or undefined if refresh failed
   */
  async refreshTokenIfExpired(currentToken: string): Promise<string | undefined> {
    if (!(await this.isTokenExpired(currentToken))) {
      // token is not expired
      return
    }

    const secret = this.generateSecret()
    const authorizationUrl = this.getAuthorizationUrl(secret)

    await this.openBrowser(authorizationUrl)

    // TODO(agrabauskas): Consider opening a port to listen to the FE.
    // The FE should send us two pieces of information
    // - Timing info that the user clicked the button, which improve the 1sec polling duration
    // - Project list which user configured for MCP access
    const newToken: string = await this.pollForToken(currentToken, secret)

    return newToken
  }

  private async isTokenExpired(token: string): Promise<boolean> {
    try {
      const response = await this.multipassApi.getTokenTimeToLiveInSeconds(token)
      return response < TokenRefreshUtils.MINIMUM_TOKEN_TTL
    } catch {
      return true
    }
  }

  private generateSecret(): string {
    return crypto.randomBytes(32).toString('hex')
  }

  private getAuthorizationUrl(secret: string): string {
    const params = new URLSearchParams({
      secret,
      origin: 'palantir-mcp',
      ...(this.repositoryRid && { repositoryRid: this.repositoryRid }),
    })

    return `https://${this.foundryApiUrl.host}/workspace/data-integration/code/gradle/auth?${params.toString()}`
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

  private async pollForToken(currentToken: string, secret: string): Promise<string> {
    const timeoutSeconds = 60
    const pollIntervalMs = 1000
    const maxAttempts = timeoutSeconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const token = await this.authoringApi.retrieveToken(secret, currentToken)
        return JSON.parse(token)
      } catch {
        // Continue polling on error
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error('Token retrieval timed out')
  }
}
