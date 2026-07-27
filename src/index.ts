import { tool } from "@opencode-ai/plugin";
import type { Hooks, PluginModule, ToolAttachment } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { perceptualHash, hammingDistance, PHASH_THRESHOLD } from "./hash";
import { dctSignature, cosineDistance } from "./sig";

// ── Search result cache (module-level) ────────────────────────────
interface CachedResult {
  title: string;
  pageUrl: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
}

interface CachedSearch {
  searchId: number;
  sourceImageUrl: string;
  engine: string;
  results: CachedResult[];
  rawText: string;
}

const searchCache = new Map<string, CachedSearch>();
const searchIdCounters = new Map<string, number>();

function searchCachePath(): string {
  return path.join(getDbDir(), "image_search_cache.json");
}

function loadSearchCacheFromDisk(): void {
  try {
    const raw = fs.readFileSync(searchCachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    for (const [key, val] of Object.entries(parsed)) {
      searchCache.set(key, val as CachedSearch);
    }
    for (const key of searchCache.keys()) {
      const match = key.match(/::search::(\d+)$/);
      if (match) {
        const sid = parseInt(match[1], 10);
        const sessionId = key.replace(/::search::\d+$/, "");
        const current = searchIdCounters.get(sessionId) ?? 0;
        if (sid > current) searchIdCounters.set(sessionId, sid);
      }
    }
  } catch {}
}

function saveSearchCacheToDisk(): void {
  try {
    const obj: Record<string, CachedSearch> = {};
    for (const [key, val] of searchCache) {
      obj[key] = val;
    }
    const dir = path.dirname(searchCachePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(searchCachePath(), JSON.stringify(obj), "utf-8");
  } catch {}
}

loadSearchCacheFromDisk();

function extractResultSections(text: string): Map<number, { title: string; pageUrl: string; thumbnailUrl: string; width: number | null; height: number | null }> {
  const map = new Map<number, { title: string; pageUrl: string; thumbnailUrl: string; width: number | null; height: number | null }>();
  const sections = text.split(/^--- Result (\d+) ---$/m);
  for (let i = 1; i < sections.length - 1; i += 2) {
    const idx = parseInt(sections[i], 10);
    const body = sections[i + 1];
    const titleMatch = body.match(/^Title:\s*(.+)$/m);
    const urlMatch = body.match(/^URL:\s*(.+)$/m);
    const thumbMatch = body.match(/^Thumbnail:\s*(.+)$/m);
    let width: number | null = null;
    let height: number | null = null;
    const sizeMatch = body.match(/^Size:\s*(\d+)x(\d+)$/m);
    if (sizeMatch) {
      width = parseInt(sizeMatch[1], 10);
      height = parseInt(sizeMatch[2], 10);
    }
    map.set(idx, {
      title: titleMatch?.[1] ?? "",
      pageUrl: urlMatch?.[1] ?? "",
      thumbnailUrl: thumbMatch?.[1] ?? "",
      width,
      height,
    });
  }
  return map;
}

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

function getDbDir(
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

function isDuplicateContent(titleLine: string, contentLine: string): boolean {
  const a = titleLine.replace(/^Title:\s*/i, "").toLowerCase().trim();
  const b = contentLine.replace(/^Content:\s*/i, "").toLowerCase().trim();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const tokenize = (s: string) =>
    new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  const ta = tokenize(a);
  const tb = tokenize(b);
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union > 0 && intersection / union >= 0.7;
}

function reformatResults(text: string): string {
  const FIELD_ORDER = ["Title", "Content", "URL", "Source", "Size", "Visual Difference"];

  const parts = text.split(/^--- Result (\d+) ---$/m);
  if (parts.length < 3) return text.trim();

  const header = parts[0].trim();

  const rebuilt: string[] = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const idx = parseInt(parts[i], 10);
    const body = parts[i + 1];
    const lines = body.split("\n");

    const fields: Record<string, string> = {};
    for (const line of lines) {
      const m = line.match(/^(Title|URL|Source|Content|Size|Visual Difference|Thumbnail):/);
      if (m) fields[m[1]] = line;
    }

    const sectionLines = FIELD_ORDER.filter(
      (k) => fields[k] && !(k === "Content" && fields["Title"] && isDuplicateContent(fields["Title"], fields[k])),
    ).map((k) => fields[k]!);
    rebuilt.push(`--- Result ${idx} ---\n${sectionLines.join("\n")}`);
  }

  return (header ? header + "\n\n" : "") + rebuilt.join("\n\n");
}

function cleanUrlsInText(text: string, sections: Map<number, { pageUrl: string }>): string {
  let result = text;
  for (const [, s] of sections) {
    if (s.pageUrl) {
      const cleanUrl = stripTrackingParams(s.pageUrl);
      if (cleanUrl !== s.pageUrl) {
        result = result.replaceAll(`URL: ${s.pageUrl}`, `URL: ${cleanUrl}`);
      }
    }
  }
  return result;
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



function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "yclid", "dclid", "msclkid",
      "_openstat", "from", "mc_cid", "mc_eid",
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString();
  } catch {
    return url;
  }
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
      if (hammingDistance(results[i].hash, results[j].hash) <= PHASH_THRESHOLD) {
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

function getBlocklist(blocklist?: string[]): Set<string> {
  const domains = new Set<string>();
  const env = process.env.IMAGE_SEARCH_BLOCKLIST;
  if (env) {
    for (const d of env.split(",")) {
      const t = d.trim().toLowerCase();
      if (t) domains.add(t);
    }
  }
  if (blocklist) {
    for (const d of blocklist) {
      const t = d.trim().toLowerCase();
      if (t) domains.add(t);
    }
  }
  return domains;
}

function matchesBlocklist(url: string, blocklist: Set<string>): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const domain of blocklist) {
      if (hostname === domain || hostname.endsWith("." + domain)) return true;
    }
  } catch {}
  return false;
}

function filterBlockedResults(text: string, blocklist: Set<string>): string {
  if (blocklist.size === 0) return text;

  const parts = text.split(/^--- Result (\d+) ---$/m);
  const header = parts[0];
  const kept: string[] = [];
  let newIdx = 1;

  for (let i = 1; i < parts.length - 1; i += 2) {
    const body = parts[i + 1];
    const url = body.match(/^URL:\s*(.+)$/m)?.[1] ?? "";
    if (!url || !matchesBlocklist(url, blocklist)) {
      kept.push(`--- Result ${newIdx} ---`, body);
      newIdx++;
    }
  }

  if (kept.length === 0) return text;

  const count = newIdx - 1;
  let h = header.replace(
    /^(Found )\d+( results.*?top )\d+/m,
    `$1${count}$2${count}`,
  );
  if (h === header && count > 0) {
    const nMatch = header.match(/(\d+)\s*results?/i);
    if (nMatch) {
      h = header.replace(/\d+\s*results?/i, `${count} results`);
    }
  }

  return h.trimEnd() + "\n\n" + kept.join("\n");
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
    blocklist: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Domains to exclude from results (e.g. x.com). Also read from IMAGE_SEARCH_BLOCKLIST env var (comma-separated)."),
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

    const origFetch = fetchImageAsBuffer(source).catch(() => null);

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
      const blocklist = getBlocklist(args.blocklist);
      const filteredText = filterBlockedResults(text, blocklist);

      const sections = extractResultSections(filteredText);
      const cachedResults: CachedResult[] = [];
      const sectionKeys = Array.from(sections.keys()).sort((a, b) => a - b);
      for (const k of sectionKeys) {
        const s = sections.get(k)!;
        cachedResults.push({
          title: s.title,
          pageUrl: stripTrackingParams(s.pageUrl),
          thumbnailUrl: s.thumbnailUrl,
          width: s.width,
          height: s.height,
        });
      }
      if (cachedResults.length > 0) {
        const searchId = (searchIdCounters.get(context.sessionID) ?? 0) + 1;
        searchIdCounters.set(context.sessionID, searchId);
        searchCache.set(`${context.sessionID}::search::${searchId}`, {
          searchId,
          sourceImageUrl: source,
          engine: args.engine ?? "Yandex",
          results: cachedResults,
          rawText: text,
        });
        saveSearchCacheToDisk();
      }

      const limit = args.limit ?? 10;
      const thumbnailUrls = extractThumbnails(filteredText).slice(0, limit);
      if (thumbnailUrls.length === 0) return reformatResults(cleanUrlsInText(filteredText, sections));

      const origResult = await origFetch;
      const origSig = origResult ? await dctSignature(origResult.buffer) : null;

      const distances = new Map<number, number>();
      const downloads: { resultIndex: number; buffer: Uint8Array; mime: string }[] = [];
      for (let i = 0; i < thumbnailUrls.length; i++) {
        try {
          const { buffer, mime } = await fetchImageAsBuffer(thumbnailUrls[i], context.abort);
          downloads.push({ resultIndex: i + 1, buffer, mime });
          if (origSig) {
            const thumbSig = await dctSignature(buffer);
            if (thumbSig) {
              distances.set(i + 1, cosineDistance(origSig.sig, thumbSig.sig));
            }
          }
        } catch {
          // skip thumbnails that fail to download
        }
      }

      if (downloads.length === 0) return reformatResults(cleanUrlsInText(filteredText, sections));

      let textWithDist = filteredText;
      if (distances.size > 0) {
        const sorted = Array.from(distances.entries()).sort((a, b) => a[0] - b[0]);
        for (const [idx, dist] of sorted.toReversed()) {
          const nextPattern = `\n--- Result ${idx + 1} ---`;
          const nextPos = textWithDist.indexOf(nextPattern);
          if (nextPos !== -1) {
            let walk = nextPos;
            while (walk > 0 && (textWithDist[walk - 1] === '\n' || textWithDist[walk - 1] === '\r')) {
              walk--;
            }
            textWithDist = textWithDist.slice(0, walk) + `\nVisual Difference: ${dist.toFixed(3)}` + textWithDist.slice(walk);
          } else {
            textWithDist = textWithDist.trimEnd() + `\nVisual Difference: ${dist.toFixed(3)}`;
          }
        }
      }
      const displayText = reformatResults(cleanUrlsInText(textWithDist, sections));

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

      if (results.length === 0) return displayText;

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

      return { output: displayText, attachments };
    } finally {
      proc.kill();
    }
  },
});

export { imageSearchTool, searchCache, searchIdCounters, loadSearchCacheFromDisk, saveSearchCacheToDisk, getDbDir, stripTrackingParams };

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
