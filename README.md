# opencode-image-search

An OpenCode tool that allows agents to reverse-search images provided in context.

## How it works

When you drop an image into OpenCode, the image's base64 data is stored in OpenCode's SQLite database. This tool queries that database directly to retrieve the data URI, then passes it to `image-search-mcp` for reverse image search.

## Usage

1. Copy `image-search.ts` to `~/.config/opencode/tools/`.
2. Agents will automatically see the tool in new sessions and can call it with an image's filename or its chronological index.
