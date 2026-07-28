import { tool } from "@opencode-ai/plugin";
import type { Hooks, PluginModule, ToolAttachment } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { perceptualHash, hammingDistance, PHASH_THRESHOLD } from "./hash";
import { dctSignature, cosineDistance } from "./sig";

// ── Types ──────────────────────────────────────────────────────────

interface SearchResult {
  index: number;
  title?: string;
  url?: string;
  thumbnail?: string;
  source?: string;
  size?: string;
  width?: number;
  height?: number;
  similarity?: number;
  content?: string;
  author?: string;
  image_url?: string;
  other_source?: string;
  episode?: number;
  domain?: string;
  crawl_date?: string;
  site_name?: string;
  type?: string;
  date?: string;
  tags?: string[];
}

interface SearchResponse {
  engine: string;
  count: number;
  results: SearchResult[];
  error?: string;
  url?: string;
}

interface FilePart {
  type: string;
  mime: string;
  url: string;
  filename?: string;
}

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
  rawResponse: string;
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

function getDbDir(
  platform = process.platform,
  appData = process.env.APPDATA,
  homeDir = os.homedir(),
): string {
  return platform === "win32"
    ? path.join(appData ?? "C:\\Users\\Default\\AppData\\Roaming", "opencode")
    : path.join(homeDir, ".local/share/opencode");
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
      "_openstat", "mc_cid", "mc_eid",
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

function isBlocked(url: string, blocklist: Set<string>): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const domain of blocklist) {
      if (hostname === domain || hostname.endsWith("." + domain)) return true;
    }
  } catch {}
  return false;
}

function filterBlockedResults(results: SearchResult[], blocklist: Set<string>): SearchResult[] {
  if (blocklist.size === 0) return results;
  const filtered = results.filter((r) => {
    const url = r.url ?? r.thumbnail ?? "";
    return !url || !isBlocked(url, blocklist);
  });
  return filtered.map((r, i) => ({ ...r, index: i + 1 }));
}

function filterBySite(results: SearchResult[], site: string): SearchResult[] {
  const q = site.trim().toLowerCase();
  if (!q) return results;
  const filtered = results.filter((r) => {
    const url = r.url ?? "";
    if (!url) return true;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === q || hostname.endsWith("." + q);
    } catch {
      return false;
    }
  });
  return filtered.map((r, i) => ({ ...r, index: i + 1 }));
}

function formatResultsText(engine: string, results: SearchResult[], distances: Map<number, number>): string {
  if (results.length === 0) return `Search Engine: ${engine}\nNo results found`;

  const lines: string[] = [
    `Search Engine: ${engine}`,
    `Found ${results.length} results (showing top ${results.length}):`,
  ];

  for (const r of results) {
    lines.push("", `--- Result ${r.index} ---`);
    if (r.title) lines.push(`Title: ${r.title}`);
    if (r.episode !== undefined) lines.push(`Episode: ${r.episode}`);
    if (r.content !== undefined) {
      const skip = r.title && (r.content === r.title || r.title.includes(r.content) || r.content.includes(r.title));
      if (!skip) lines.push(`Content: ${r.content}`);
    }
    if (r.author) lines.push(`Author: ${r.author}`);
    if (r.type) lines.push(`Type: ${r.type}`);
    if (r.tags && r.tags.length > 0) lines.push(`Tags: ${r.tags.join(", ")}`);
    if (r.url) lines.push(`URL: ${stripTrackingParams(r.url)}`);
    if (r.site_name) lines.push(`Site: ${r.site_name}`);
    if (r.domain) lines.push(`Domain: ${r.domain}`);
    if (r.source) lines.push(`Source: ${r.source}`);
    if (r.other_source) lines.push(`Other Source: ${r.other_source}`);
    if (r.date) lines.push(`Date: ${r.date}`);
    if (r.crawl_date) lines.push(`Crawl Date: ${r.crawl_date}`);
    if (r.size) lines.push(`Size: ${r.size}`);
    const dist = distances.get(r.index);
    if (r.similarity !== undefined) {
      lines.push(`Similarity: ${r.similarity.toFixed(1)}%`);
    } else if (dist !== undefined) {
      lines.push(`Similarity: ${(100 * (1 - dist / 2)).toFixed(1)}%`);
    }
  }

  return lines.join("\n");
}

const imageSearchTool = tool({
  description:
    "Retrieve an image from the session and perform a reverse image search. " +
    "Omit all args to use the most recent image. " +
    "Supports multiple search engines via PicImageSearch (default: Yandex). " +
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
    site: tool.schema
      .string()
      .optional()
      .describe("Only return results from this domain (e.g. y.com). Takes precedence over blocklist."),
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

    const searchPyPath = path.join(import.meta.dir, "search.py");
    const proc = Bun.spawn(["uv", "run", searchPyPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    let response: SearchResponse;
    try {
      const input = JSON.stringify({
        source,
        engine: args.engine ?? "Yandex",
        limit: args.limit ?? 10,
      });
      proc.stdin.write(input);
      proc.stdin.end();

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buf += decoder.decode(value, { stream: true });
      }
      response = JSON.parse(buf) as SearchResponse;
    } finally {
      proc.kill();
    }

    if (response.error) {
      return `Search failed (${response.engine}): ${response.error}`;
    }

    const blocklist = getBlocklist(args.blocklist);
    const results = args.site
      ? filterBySite(response.results, args.site)
      : filterBlockedResults(response.results, blocklist);

    const cachedResults: CachedResult[] = results.map((r) => ({
      title: r.title ?? "",
      pageUrl: stripTrackingParams(r.url ?? ""),
      thumbnailUrl: r.thumbnail ?? "",
      width: r.width ?? null,
      height: r.height ?? null,
    }));

    if (cachedResults.length > 0) {
      const searchId = (searchIdCounters.get(context.sessionID) ?? 0) + 1;
      searchIdCounters.set(context.sessionID, searchId);
      searchCache.set(`${context.sessionID}::search::${searchId}`, {
        searchId,
        sourceImageUrl: source,
        engine: response.engine,
        results: cachedResults,
        rawResponse: JSON.stringify(response),
      });
      saveSearchCacheToDisk();
    }

    if (results.length === 0) {
      const hadResults = response.results.length > 0;
      return hadResults
        ? `All results were filtered by ${args.site ? `site filter (${args.site})` : "domain blocklist"}`
        : `Search Engine: ${response.engine}\nNo results found`;
    }

    const limit = args.limit ?? 10;
    const bestImageUrl = (r: SearchResult) => r.image_url || r.thumbnail;
    const imageUrls = results.map((r) => bestImageUrl(r)).filter(Boolean).slice(0, limit);

    if (imageUrls.length === 0) {
      return formatResultsText(response.engine, results, new Map());
    }

    const origResult = await origFetch;
    const origSig = origResult ? await dctSignature(origResult.buffer) : null;

    const distances = new Map<number, number>();
    const downloads: { resultIndex: number; buffer: Uint8Array; mime: string }[] = [];
    let downloadCount = 0;
    for (const r of results) {
      const url = bestImageUrl(r);
      if (!url || downloadCount >= limit) continue;
      downloadCount++;
      try {
        const { buffer, mime } = await fetchImageAsBuffer(url, context.abort);
        downloads.push({ resultIndex: r.index, buffer, mime });
        if (origSig) {
          const thumbSig = await dctSignature(buffer);
          if (thumbSig) {
            distances.set(r.index, cosineDistance(origSig.sig, thumbSig.sig));
          }
        }
      } catch {
        // skip thumbnails that fail to download
      }
    }

    if (downloads.length === 0) {
      return formatResultsText(response.engine, results, distances);
    }

    const displayText = formatResultsText(response.engine, results, distances);

    const thumbnailResults: ThumbnailResult[] = [];
    for (const dl of downloads) {
      const ph = await perceptualHash(dl.buffer);
      if (ph) {
        thumbnailResults.push({
          resultIndex: dl.resultIndex,
          buffer: dl.buffer,
          mime: dl.mime,
          hash: ph.hash,
          pixels: ph.width * ph.height,
        });
      }
    }

    if (thumbnailResults.length === 0) return displayText;

    const groups = deduplicate(thumbnailResults);

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
