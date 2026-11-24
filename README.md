<p align="right">
<a href="https://autorelease.general.dmz.palantir.tech/palantir/palantir-mcp"><img src="https://img.shields.io/badge/Perform%20an-Autorelease-success.svg" alt="Autorelease"></a>
</p>

# Palantir MCP

A lightweight open-source wrapper for downloading and installing the @palantir/mcp package from secure Foundry environments.

## Overview

This tool provides a streamlined way to access and run Palantir's Model Context Protocol (MCP) server from within Foundry environments. It handles authentication, package retrieval, and environment setup automatically.

## How It Works

1. **Preflight Checks**: Validates Node.js version, network connectivity to Foundry, and token authentication
2. **Registry Setup**: Configures NPM to use Foundry's internal package registry
3. **Package Execution**: Downloads and runs the latest @palantir/mcp package from your secure Foundry environment with your provided arguments

## 🛠️ Installation

### Requirements

- Node.js 18 or higher
- Valid Foundry instance access
- Foundry access with appropriate permissions: a user token for legacy mode, or an approved OAuth client installation

### MCP Inspector

Test the palantir-mcp using the mcp-inspector package.

```sh
# Replace the below with your Foundry URL
export FOUNDRY_HOST="<enrollment>.palantirfoundry.com"

# Replace the below with your Foundry Token
export FOUNDRY_TOKEN=<token>

npx @modelcontextprotocol/inspector \
  npx -y palantir-mcp \
  --foundry-api-url \
  https://$FOUNDRY_HOST
```

### Claude Code

```bash
# Replace the below with your Foundry URL
export FOUNDRY_HOST="<enrollment>.palantirfoundry.com"

# Replace the below with your Foundry Token
export FOUNDRY_TOKEN=<token>

claude mcp add palantir-mcp \
    --scope user \
    -e FOUNDRY_TOKEN=$FOUNDRY_TOKEN \
    -- npx "-y" "palantir-mcp" "--foundry-api-url" "https://$FOUNDRY_HOST"
```

### Cursor

```json
{
  "mcpServers": {
    "palantir-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "palantir-mcp",
        "--foundry-api-url",
        "https://<enrollment>.palantirfoundry.com" // Replace with your Foundry URL
      ],
      "env": {
        "FOUNDRY_TOKEN": "<token>" // Replace with your Foundry Token
      }
    }
  }
}
```

### VS Code Copilot

```json
"mcp": {
    "inputs": [
        {
            "type": "promptString",
            "id": "foundry-token",
            "description": "Foundry user token",
            "password": true
        }
    ],
    "servers": {
        "Palantir": {
            "type": "stdio",
            "command": "npx",
            "args": [
                "-y",
                "palantir-mcp",
                "--foundry-api-url",
                "https://<enrollment>.palantirfoundry.com" // Replace with your Foundry URL
            ],
            "env": {
                "FOUNDRY_TOKEN": "${input:foundry-token}"
            }
        }
    }
}
```

### Cline

```json
{
  "mcpServers": {
    "palantir-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "palantir-mcp",
        "--foundry-api-url",
        "https://<enrollment>.palantirfoundry.com" // Replace with your Foundry URL
      ],
      "env": {
        "FOUNDRY_TOKEN": "<token>" // Replace with your Foundry Token
      },
      "disabled": false
    }
  }
}
```

## OAuth

Pass `--auth=oauth` to sign in through your browser instead of using a Foundry token.
On first startup, the browser opens for consent before the MCP package is downloaded.
Later starts reuse or renew the saved credentials in `~/.palantir/mcp-oauth`.

```sh
npx -y palantir-mcp --auth=oauth \
  --foundry-api-url https://<enrollment>.palantirfoundry.com
```

- `--oauth-scopes "<scopes>"` sets the requested scopes. The default is
  `palantir-mcp:read-metadata palantir-mcp:write-metadata palantir-mcp:read-data palantir-mcp:write-data palantir-mcp:execute`.
  `offline_access` requests refresh capability; `auth status` reports whether it was granted, and OAuth endpoints are discovered from the server's metadata.
- `--oauth-profile <name>` keeps separate credentials for the same host.
- Optional `auth login`, `auth refresh`, `auth status` and `auth logout` commands sign in
  ahead of time, renew credentials, show credential status, or remove local credentials.
  Each takes `--foundry-api-url` and the same OAuth overrides as startup; `--auth=oauth`
  is optional for these commands. Refresh opens browser consent if needed and waits for it to finish.
  Logout does not revoke server tokens.

```sh
npx -y palantir-mcp auth status \
  --foundry-api-url https://<enrollment>.palantirfoundry.com
```

Your Foundry environment must permit the OAuth application and requested operations and provide
a compatible `@palantir/mcp` release. To switch back to token authentication, remove
`--auth=oauth` (or pass `--auth=legacy`). Legacy authentication remains the default.
`--foundry-token` cannot be combined with `--auth=oauth`; OAuth does not use `FOUNDRY_TOKEN`.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- --foundry-api-url https://<enrollment>.palantirfoundry.com --foundry-token <token>

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build for production
npm run build

# Lint and format
npm run lint
npm run format
```

## Architecture

The tool is organized into focused modules:

- `command.ts` - Legacy command-line argument parsing and validation
- `tokenProvider.ts` - Common token acquisition interface, implemented by `legacyTokenProvider.ts`
  and `auth/tokenProvider.ts` without mixing credential sources
- `auth/` - `--auth` mode selection, OAuth PKCE lifecycle, shared v1 credential state, OAuth
  startup (registry, bounded download, private handoff) and `auth` commands
- `spawn.ts` - Process spawning and signal handling
- `registry.ts` - NPM registry URL construction
- `errors.ts` - Custom error classes for better error handling
- `preflightChecks.ts` - Validation of environment and credentials
- `index.ts` - Main orchestration logic

## Error Handling

The tool provides detailed error messages for common issues:

- **Node Version Error**: When Node.js version is below 18
- **Network Error**: When unable to reach Foundry API
- **Authentication Error**: When token is invalid or expired
- **Package Fetch Error**: When unable to retrieve the MCP package

## Contributing

Contributions are welcome! Please ensure:

1. All tests pass (`npm test`)
2. Code is properly linted (`npm run lint`)
3. Code is formatted (`npm run format`)
4. Type checking passes (`npm run typecheck`)

## License

MIT - See LICENSE file for details

## Support

For issues related to:

- This wrapper tool: Please open an issue in this repository
- The underlying @palantir/mcp package: Contact Foundry support
- Foundry access or tokens: Contact your Foundry administrator
