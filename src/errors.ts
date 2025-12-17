/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export class McpError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export class NodeVersionError extends McpError {
  constructor(currentVersion: string) {
    super(
      `Node.js version ${currentVersion} is not supported for Palantir MCP. Please upgrade to Node.js 18 or higher.`,
    )
    this.name = 'NodeVersionError'
  }
}

export class NetworkError extends McpError {
  constructor(url: URL, cause: unknown) {
    super(
      `Unable to reach the Foundry API at ${url}. Please ensure:
- You are using the correct URL for your Foundry instance. It should be of the format https://<enrollment>.palantirfoundry.com.
- Your network connection allows access to the Foundry instance (e.g. VPN, firewall settings).
- You are able to access the Foundry instance via a web browser.

If you continue to experience issues, please contact your Foundry administrator for assistance.`,
      cause,
    )
    this.name = 'NetworkError'
  }
}

export class AuthenticationTimoutError extends McpError {
  constructor() {
    super('Token retrieval timed out')
    this.name = 'AuthenticationTimoutError'
  }
}

export class InvalidAuthTokenError extends McpError {
  constructor(foundryHostname: string) {
    super(
      // TODO: message should say "This token was not provisioned by X environment, it may either be malformed or it was privisioned for a different iunstance of Foundry."
      `You have provided a malformed authentication token. Please generate a new one at https://${foundryHostname}/workspace/settings/tokens.`,
    )
    this.name = 'InvalidAuthTokenError'
  }
}

export class PackageFetchError extends McpError {
  constructor(cause: unknown) {
    super(
      'Unable to fetch the Palantir MCP package. Please contact Foundry support for assistance.',
      cause,
    )
    this.name = 'PackageFetchError'
  }
}
