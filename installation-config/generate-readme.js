const cursorConfig = {
    "mcpServers": {
        "palantir-mcp": {
            "type": "stdio",
            "command": "npx",
            "args": [
                "-y",
                "palantir-mcp",
                "--foundry-api-url",
                "https://enrollment.palantirfoundry.com"
            ],
            "env": {
                "FOUNDRY_TOKEN": "<token>"
            }
        }
    }
};

const cursorDeepLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=palantir-mcp&config=${encodeURIComponent(btoa(JSON.stringify(cursorConfig)))}`

console.log(cursorDeepLink);

console.log(`[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](${cursorDeepLink})`)
