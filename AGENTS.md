# opencode-image-search

OpenCode plugin that reverse-searches images dropped into chat.

## Install

Add `"opencode-image-search"` to `opencode.json`'s `plugins` array. OpenCode auto-installs it.

## How it works

The plugin registers a single tool (`image_search`) via the `tool` hook in `src/index.ts`. Agents invoke this tool to reverse-search images from the current session.

1. Reads OpenCode's SQLite DB (`~/.local/share/opencode/opencode.db`) to find base64-encoded image attachments for the current session, ordered chronologically.
2. Filters by filename (case-insensitive substring) and/or 1-based index (default: latest image).
3. Spawns `uvx image-search-mcp` and talks JSON-RPC 2.0 over stdin/stdout to perform the actual reverse image search.
4. Returns the text results to the agent. When thumbnail URLs (`Thumbnail: <url>`) appear in the response, the plugin downloads them, deduplicates near-matches via perceptual hashing (keeping only the highest-resolution copy of each unique image), and attaches the survivors as images for vision-capable models. Merged filenames (e.g. `result_1-5,7,9-10.jpeg`) record which results each thumbnail represents — runs of consecutive results collapse into a range.

## Arguments

| Arg | Type | Default | Description |
|---|---|---|---|
| `index` | `number?` | most recent | 1 = oldest image in the conversation |
| `filename` | `string?` | — | Filter by filename (case-insensitive) |
| `engine` | `string?` | `"Yandex"` | Yandex, SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye |
| `limit` | `number?` | `10` | Max results |
| `blocklist` | `string[]?` | — | Domains to exclude (e.g. `x.com`). Also read from `IMAGE_SEARCH_BLOCKLIST` env var. |

## Environment variables

These are inherited from OpenCode each time the tool is invoked. Set them via OpenCode's `env` config or your shell.

| Variable | Applies to | Description |
|---|---|---|
| `IMAGE_SEARCH_API_KEY` | SauceNAO | API key |
| `IMAGE_SEARCH_COOKIES` | Google, Bing, Yandex, Tineye, EHentai, GoogleLens | Browser cookies to bypass bot protection |
| `IMAGE_SEARCH_PROXY` | All engines | Proxy URL (e.g. `http://127.0.0.1:7890`). Falls back to `HTTP_PROXY` / `HTTPS_PROXY`. |
| `IMAGE_SEARCH_BLOCKLIST` | `image_search` | Comma-separated domains to exclude from results (e.g. `x.com,y.com`) |

## Code conventions

- Main entry `src/index.ts` with helper modules `src/hash.ts` (perceptual hashing via DCT) and `src/sig.ts` (DCT signature computation), plus an npm `package.json`.
- Depends on `@opencode-ai/plugin` (provided by the OpenCode runtime), `cross-image` (image decoding for DCT-based signature computation), and `bun:sqlite` (built into Bun).
- Read-only DB access, clean up resources in `finally` blocks.

## Limitations

Text-only agents can see image filenames (they are exposed in the conversation history) but cannot visually validate reverse-search results. As such, returned results are more like investigative leads than verified answers.

## Testing

Run all tests with `bun test`. Uses `mock.module` to stub `bun:sqlite`, `@opencode-ai/plugin`, and `cross-image`, and replaces `Bun.spawn` with a fake subprocess that returns pre-scripted JSON-RPC responses.
