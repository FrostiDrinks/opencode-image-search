## How it works

When you drop an image into OpenCode, the image's base64 data is stored in OpenCode's SQLite database. This tool queries that database directly to retrieve the data URI, then uses [`image-search-mcp`](https://pypi.org/project/image-search-mcp/) to reverse image search without requiring agents to handle full URI data themselves.

## Usage

1. Copy `image-search.ts` to `~/.config/opencode/tools/`.
2. Agents will see the tool in new sessions and can call it using either the filename or chronological index of the desired image.
