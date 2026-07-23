import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import type { Hooks, PluginModule, ToolAttachment } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Image } from "cross-image";

interface FilePart {
  type: string;
  mime: string;
  url: string;
  filename?: string;
}

interface McpResponse {
  content?: { type: string; text: string }[];
}

function writeMsg(stdin: { write(data: string): number; flush(): void }, msg: object) {
  stdin.write(`${JSON.stringify(msg)}\n`);
  stdin.flush();
}

async function readResponse(
  reader: ReadableStreamDefaultReader,
  id: number,
  timeoutMs = 30_000,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let buf = "";

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const resp = JSON.parse(trimmed);
        if (resp.id === id) {
          if (resp.error) throw new Error(resp.error.message);
          return resp.result;
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  throw new Error("MCP response timeout or connection closed");
}

export function getDbDir(
  platform = process.platform,
  appData = process.env.APPDATA,
  homeDir = os.homedir(),
): string {
  return platform === "win32"
    ? path.join(appData ?? "C:\\Users\\Default\\AppData\\Roaming", "opencode")
    : path.join(homeDir, ".local/share/opencode");
}

const THUMBNAIL_RE = /^Thumbnail: (.+)$/gm;

function extractThumbnails(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(THUMBNAIL_RE)) {
    urls.push(match[1]);
  }
  return urls;
}

async function fetchImageAsBuffer(
  url: string,
  signal?: AbortSignal,
): Promise<{ buffer: Uint8Array; mime: string }> {
  const resp = await fetch(url, { signal });
  const blob = await resp.blob();
  const mime = blob.type || "image/jpeg";
  const buffer = new Uint8Array(await blob.arrayBuffer());
  return { buffer, mime };
}

const DHASH_THRESHOLD = 10;

async function perceptualHash(
  data: Uint8Array,
): Promise<{ hash: bigint; width: number; height: number } | null> {
  try {
    const img = await Image.decode(data);
    const origWidth = img.width;
    const origHeight = img.height;
    img.resize({ width: 9, height: 8 });
    const pixels = img.data;

    let hash = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const idx = (y * 9 + x) * 4;
        const idxNext = (y * 9 + x + 1) * 4;
        const left = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
        const right =
          0.299 * pixels[idxNext] + 0.587 * pixels[idxNext + 1] + 0.114 * pixels[idxNext + 2];
        if (left > right) hash |= 1n << BigInt(y * 8 + x);
      }
    }
    return { hash, width: origWidth, height: origHeight };
  } catch {
    return null;
  }
}

function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

interface ThumbnailResult {
  resultIndex: number;
  buffer: Uint8Array;
  mime: string;
  hash: bigint;
  pixels: number;
}

function deduplicate(results: ThumbnailResult[]): { winner: ThumbnailResult; indices: number[] }[] {
  const n = results.length;
  const parent = results.map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    parent[find(a)] = find(b);
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hammingDistance(results[i].hash, results[j].hash) <= DHASH_THRESHOLD) {
        union(i, j);
      }
    }
  }

  const groupMap = new Map<number, ThumbnailResult[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)?.push(results[i]);
  }

  return Array.from(groupMap.values()).map((items) => {
    items.sort((a, b) => b.pixels - a.pixels);
    return {
      winner: items[0],
      indices: items.map((i) => i.resultIndex).sort((a, b) => a - b),
    };
  });
}

function formatIndices(indices: number[]): string {
  if (indices.length === 0) return "";
  const parts: string[] = [];
  let start = indices[0];
  let end = indices[0];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === end + 1) {
      end = indices[i];
    } else {
      parts.push(start === end ? `${start}` : `${start}-${end}`);
      start = indices[i];
      end = indices[i];
    }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(",");
}

const imageSearchTool = tool({
  description:
    "Retrieve an image from the session and perform a reverse image search. " +
    "Omit all args to use the most recent image. " +
    "Supports multiple search engines via image-search-mcp (default: Yandex). " +
    "Text-only models: use this tool when asked about an image you cannot view.",
  args: {
    index: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("1 = oldest image in the conversation; omit for most recent"),
    filename: tool.schema
      .string()
      .optional()
      .describe(
        "Filter by filename (case-insensitive substring match). Check the conversation for filenames to target a specific image.",
      ),
    engine: tool.schema
      .string()
      .optional()
      .describe(
        "Search engine: Yandex (default), SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye",
      ),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .default(10)
      .optional()
      .describe("Max number of results (default: 10)"),
  },
  async execute(args, context) {
    const db = new Database(path.join(getDbDir(), "opencode.db"), { readonly: true });

    let rows: { data: string }[];
    try {
      rows = db
        .query(
          `SELECT p.data
           FROM part p
           WHERE p.session_id = $sessionID
             AND json_extract(p.data, '$.type') = 'file'
             AND json_extract(p.data, '$.mime') LIKE 'image/%'
           ORDER BY p.id ASC`,
        )
        .all({ $sessionID: context.sessionID }) as { data: string }[];
    } finally {
      db.close();
    }

    if (rows.length === 0) return "No image attachments found in this session";

    const parts = rows.map((r) => JSON.parse(r.data)) as FilePart[];

    let candidates = parts;

    if (args.filename) {
      const q = args.filename.toLowerCase();
      candidates = parts.filter((p: FilePart) => p.filename?.toLowerCase().includes(q));
      if (candidates.length === 0)
        return `No image found with filename matching "${args.filename}"`;
    }

    const idx = args.index ?? candidates.length;
    if (idx > candidates.length) {
      const total = candidates.length;
      return `Index ${idx} out of range. ${args.filename ? `Matching "${args.filename}": ` : ""}${total} image${total > 1 ? "s" : ""} available (1 = first, ${total} = most recent).`;
    }

    const source = candidates[idx - 1].url;

    const proc = Bun.spawn(["uvx", "image-search-mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    try {
      const reader = proc.stdout.getReader();

      writeMsg(proc.stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "opencode-image-search", version: "1.0" },
        },
      });
      await readResponse(reader, 1);

      writeMsg(proc.stdin, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      writeMsg(proc.stdin, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_image",
          arguments: {
            source,
            engine: args.engine ?? "Yandex",
            limit: args.limit ?? 10,
          },
        },
      });
      const result = (await readResponse(reader, 2)) as McpResponse;

      const text = result?.content?.[0]?.text ?? JSON.stringify(result);

      const limit = args.limit ?? 10;
      const thumbnailUrls = extractThumbnails(text).slice(0, limit);
      if (thumbnailUrls.length === 0) return text;

      const downloads: { resultIndex: number; buffer: Uint8Array; mime: string }[] = [];
      for (let i = 0; i < thumbnailUrls.length; i++) {
        try {
          const { buffer, mime } = await fetchImageAsBuffer(thumbnailUrls[i], context.abort);
          downloads.push({ resultIndex: i + 1, buffer, mime });
        } catch {
          // skip thumbnails that fail to download
        }
      }

      if (downloads.length === 0) return text;

      const results: ThumbnailResult[] = [];
      for (const dl of downloads) {
        const ph = await perceptualHash(dl.buffer);
        if (ph) {
          results.push({
            resultIndex: dl.resultIndex,
            buffer: dl.buffer,
            mime: dl.mime,
            hash: ph.hash,
            pixels: ph.width * ph.height,
          });
        }
      }

      if (results.length === 0) return text;

      const groups = deduplicate(results);

      const attachments: ToolAttachment[] = [];
      for (const group of groups) {
        const { winner, indices } = group;
        const ext = winner.mime.split("/")[1] || "jpg";
        const base64 = Buffer.from(winner.buffer).toString("base64");
        attachments.push({
          type: "file",
          mime: winner.mime,
          url: `data:${winner.mime};base64,${base64}`,
          filename: `result_${formatIndices(indices)}.${ext}`,
        });
      }

      return { output: text, attachments };
    } finally {
      proc.kill();
    }
  },
});

export { imageSearchTool };

export default {
  id: "image_search",
  async server(): Promise<Hooks> {
    return {
      tool: {
        image_search: imageSearchTool,
      },
    };
  },
} satisfies PluginModule;
