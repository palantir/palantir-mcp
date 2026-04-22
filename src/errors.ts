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
    super(
      'Timed out waiting for browser authentication. ' +
        'Common causes: browser login was not completed, ' +
        'or the existing token belongs to a different Foundry environment than the target.',
    )
    this.name = 'AuthenticationTimoutError'
  }
}

export class InvalidAuthTokenError extends McpError {
  constructor(foundryHostname: string) {
    super(
      `Invalid token provided. You have either:
- provided a malformed authentication token, or:
- a token belonging to a different Foundry environment from (${foundryHostname}).

Please generate a new Token at https://${foundryHostname}/workspace/settings/tokens and export it to your FOUNDRY_TOKEN environment variable.`,
    )
    this.name = 'InvalidAuthTokenError'
  }
}

export class NoTokenAvailableError extends McpError {
  constructor(foundryHostname: string) {
    super(
      `No Foundry token available for ${foundryHostname}.\n\n` +
        `Please provide a token using one of these methods:\n` +
        `  1. Set the FOUNDRY_TOKEN environment variable\n` +
        `  2. Pass --foundry-token <token> as a CLI argument\n\n` +
        `You can generate a token at https://${foundryHostname}/workspace/settings/tokens\n\n` +
        `After the first successful authentication, the token will be cached for future sessions.`,
    )
    this.name = 'NoTokenAvailableError'
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
