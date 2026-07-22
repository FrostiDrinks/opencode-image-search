# opencode-image-search

OpenCode plugin that reverse-searches images dropped into chat.

## Install

Add `"opencode-image-search"` to `opencode.json`'s `plugins` array. OpenCode auto-installs it.

## How it works

The plugin registers a single tool (`image_search`) via the `tool` hook in `src/index.ts`. Agents invoke this tool to reverse-search images from the current session.

1. Reads OpenCode's SQLite DB (`~/.local/share/opencode/opencode.db`) to find base64-encoded image attachments for the current session, ordered chronologically.
2. Filters by filename (case-insensitive substring) and/or 1-based index (default: latest image).
3. Spawns `uvx image-search-mcp` and talks JSON-RPC 2.0 over stdin/stdout to perform the actual reverse image search.
4. Returns the text results to the agent. When thumbnail URLs (`Thumbnail: <url>`) appear in the response, the plugin downloads them and attaches them as images for vision-capable models.

## Arguments

| Arg | Type | Default | Description |
|---|---|---|---|
| `index` | `number?` | most recent | 1 = oldest image in the conversation |
| `filename` | `string?` | — | Filter by filename (case-insensitive) |
| `engine` | `string?` | `"Yandex"` | Yandex, SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye |
| `limit` | `number?` | `10` | Max results |

## Code conventions

- Single `src/index.ts` file with an npm `package.json`.
- Depends on `@opencode-ai/plugin` (provided by the OpenCode runtime) and `bun:sqlite` (built into Bun).
- Read-only DB access, clean up resources in `finally` blocks.

## Limitations

Text-only agents can see image filenames (they are exposed in the conversation history) but cannot visually validate reverse-search results. As such, returned results are more like investigative leads than verified answers.

## Testing

Run all tests with `bun test`. Uses `mock.module` to stub `bun:sqlite` and `@opencode-ai/plugin`, and replaces `Bun.spawn` with a fake subprocess that returns pre-scripted JSON-RPC responses.
