# opencode-image-search

OpenCode plugin that allows agents to reverse-search images dropped into chat.

When you drop an image into OpenCode, the image's base64 data is stored in OpenCode's SQLite database. This tool queries that database directly to retrieve the data URI, then uses [`image-search-mcp`](https://pypi.org/project/image-search-mcp/) to reverse image search without requiring agents to handle full URI data themselves.

## Install

Add `opencode-image-search` to `opencode.json`:

```json
{
  "plugins": ["opencode-image-search"]
}
```

OpenCode will install it automatically on startup.

## Usage

Once installed, the plugin registers an `image_search` tool that agents can invoke on-demand when a given image requires more context.

### Arguments (agent-controlled)

| Arg | Type | Default | Description |
|---|---|---|---|
| `index` | `number?` | most recent | 1 = oldest image in the conversation |
| `filename` | `string?` | — | Filter by filename (case-insensitive) |
| `engine` | `string?` | `"Yandex"` | Yandex, SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye |
| `limit` | `number?` | `10` | Max results |

### Model compatibility

Each unique thumbnail (see [thumbnail deduplication](#thumbnail-deduplication)) is returned to vision-capable models as an image attachment. This lets them visually cross-reference the original image against the results and discard false positives.

Filenames of image attachments are visible in the conversation history, so text-only models can reliably target the right image via the `filename` argument. However, they **cannot** directly validate the output. Results are drawn from the search engine's text snippets, so the model must take them on faith.

### Environment variables

These are inherited from OpenCode each time the tool is invoked. If required, set them in your shell or via OpenCode's `env` config.

| Variable | Applies to | Description |
|---|---|---|
| `IMAGE_SEARCH_API_KEY` | SauceNAO | API key |
| `IMAGE_SEARCH_COOKIES` | Google, Bing, Yandex, Tineye, EHentai, GoogleLens | Browser cookies to bypass bot protection |
| `IMAGE_SEARCH_PROXY` | All engines | Proxy URL (e.g. `http://127.0.0.1:7890`). Falls back to `HTTP_PROXY` / `HTTPS_PROXY`. |

## How it works

1. Reads OpenCode's SQLite DB (`~/.local/share/opencode/opencode.db`) to find base64-encoded image attachments for the current session, ordered chronologically.
2. Filters by filename (case-insensitive substring) and/or 1-based index (default: latest image).
3. Spawns `uvx image-search-mcp` and talks JSON-RPC 2.0 over stdin/stdout to perform the actual reverse image search.
4. Returns the text results to the agent, with result thumbnails attached as images for vision-capable models.

### Thumbnail deduplication

When multiple search results return the same image (identical or visually similar), the plugin keeps only the **highest resolution** thumbnail and attaches it once. The filename records every result it maps to, with runs of consecutive results collapsing into a range (e.g. `result_1-5,7,9-10.jpeg` represents results 1–5, 7, and 9–10).

Deduplication uses a perceptual hash (dHash). Images within a Hamming distance of 10 bits are grouped together. This catches same-file duplicates, different-compression variants, and same-image-different-resolution returns.

## Development

```bash
bun test
```

Uses `mock.module` to stub `bun:sqlite`, `@opencode-ai/plugin`, and `cross-image`, and replaces `Bun.spawn` with a fake subprocess that returns pre-scripted JSON-RPC responses.
