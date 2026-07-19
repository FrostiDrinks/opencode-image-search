# opencode-image-search

OpenCode tool that reverse-searches images dropped into chat.

## Workflow

1. **Reads OpenCode's SQLite DB** (`~/.local/share/opencode/opencode.db`) to find base64-encoded image attachments for the current session, ordered chronologically.
2. **Filters** by filename (case-insensitive substring) and/or 1-based index (default: latest image).
3. **Spawns** `uvx image-search-mcp` and talks JSON-RPC 2.0 over stdin/stdout to perform the actual reverse image search.
4. **Returns** the text results to the agent.

## Arguments

| Arg | Type | Default | Description |
|---|---|---|---|
| `index` | `number?` | `1` | 1 = first image in the conversation |
| `filename` | `string?` | — | Filter by filename (case-insensitive) |
| `engine` | `string?` | `"Yandex"` | Yandex, SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye |
| `limit` | `number?` | `10` | Max results |

## Code conventions

- Single `.ts` file, no `package.json` or bundler — just copy into the tools dir.
- Depends on `@opencode-ai/plugin` (provided by the OpenCode runtime) and `bun:sqlite` (built into Bun).
- Read-only DB access, clean up resources in `finally` blocks.
