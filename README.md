# opencode-image-search

A custom tool that allows opencode agents to reverse image search chat images.

## How it works

When you drop an image into opencode, the image's base64 data is stored in opencode's SQLite database. This tool queries that database directly to retrieve the data URI, then passes it to `image-search-mcp` for reverse image search.

## Usage

1. Copy `image-search.ts` to `~/.config/opencode/tools/`.
2. Agents will automatically see the tool in new sessions and can reverse image search using either a chat image's filename or its chronological index.
