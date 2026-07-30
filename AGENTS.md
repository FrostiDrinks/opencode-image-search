# opencode-image-search

OpenCode plugin that reverse-searches images dropped into chat.

## Install

Add `"opencode-image-search"` to `opencode.json`'s `plugins` array. OpenCode auto-installs it.

## How it works

The plugin registers a single tool (`image_search`) via the `tool` hook in `src/index.ts`. Agents invoke this tool to reverse-search images from the current session.

1. Finds base64-encoded image attachments for the current session using `bun:sqlite` or `context.messages` depending on runtime, ordered chronologically.
2. Filters by filename (case-insensitive substring) and/or 1-based index (default: latest image).
3. Spawns `uv run src/search.py` which uses `PicImageSearch` to return structured JSON over stdout.
4. Returns the text results to the agent. When thumbnails appear in the JSON response, the plugin downloads them, deduplicates near-matches via perceptual hashing (keeping only the highest-resolution copy of each unique image), and attaches the survivors as images for vision-capable models. Merged filenames (e.g. `result_1-5,7,9-10.jpeg`) record which results each thumbnail represents — runs of consecutive results collapse into a range.

## Arguments

| Arg | Type | Default | Description |
|---|---|---|---|
| `index` | `number?` | most recent | 1 = oldest image in the conversation |
| `filename` | `string?` | — | Filter by filename (case-insensitive) |
| `engine` | `string?` | `"Yandex"` | Yandex, SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye |
| `limit` | `number?` | `10` | Max results |
| `blocklist` | `string[]?` | — | Domains to exclude (e.g. `x.com`). Also read from `IMAGE_SEARCH_BLOCKLIST` env var. |
| `site` | `string?` | — | Only return results from this domain (e.g. `y.com`). Takes precedence over blocklist. |

## Environment variables

These are inherited from OpenCode each time the tool is invoked. Set them via OpenCode's `env` config or your shell.

| Variable | Applies to | Description |
|---|---|---|
| `IMAGE_SEARCH_API_KEY` | SauceNAO | API key |
| `IMAGE_SEARCH_COOKIES` | Google, Bing, Yandex, Tineye, EHentai, GoogleLens | Browser cookies to bypass bot protection |
| `IMAGE_SEARCH_PROXY` | All engines | Proxy URL (e.g. `http://127.0.0.1:7890`). Falls back to `HTTP_PROXY` / `HTTPS_PROXY`. |
| `IMAGE_SEARCH_BLOCKLIST` | `image_search` | Comma-separated domains to exclude from results (e.g. `x.com,y.com`) |

## Code conventions

- Main entry `src/index.ts` with helper modules `src/hash.ts` (perceptual hashing via DCT), `src/sig.ts` (DCT signature computation), and `src/images.ts` (cross-runtime image discovery), plus an npm `package.json`.
- Uses `bun:sqlite` when running in Bun (CLI) and falls back to `context.messages` in Node.js (desktop). Read-only DB access, clean up resources in `finally` blocks.

## Limitations

Text-only agents can see image filenames (they are exposed in the conversation history) but cannot visually validate reverse-search results. As such, returned results are more like investigative leads than verified answers.

## Testing

Run all tests with `bun test`. Uses `mock.module` to stub `@opencode-ai/plugin`, `child_process`, `cross-image`, `./src/images`, and `./src/hash`, with a fake subprocess that returns pre-scripted JSON responses.
