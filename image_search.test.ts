import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import path from "node:path";
import { Readable } from "node:stream";

declare global {
  var __crossImageDecodeState: {
    presets: { hash: bigint; width: number; height: number }[];
    index: number;
  };
  var __hashMockState: {
    presets: { hash: bigint; width: number; height: number }[];
    index: number;
  };
}

// --- Mock schema chain helpers ---
// biome-ignore lint/suspicious/noExplicitAny: mock chain helper
function desc(): any {
  return {};
}
function opt() {
  return { describe: desc };
}
function def() {
  return { optional: opt };
}
function pos() {
  return { optional: opt, default: def };
}
function int() {
  return { positive: pos };
}

mock.module("@opencode-ai/plugin", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock
  const tool = Object.assign((cfg: any) => cfg, {
    schema: {
      number: () => ({ int }),
      string: () => ({ optional: opt }),
      array: () => ({ optional: opt }),
    },
  });
  return { default: tool, tool };
});

let mockRows: { data: string }[] = [];

// ── child_process mock (delegates to mutable variable) ────────────
// The factory uses require() inside the mock.module callback, which
// bypasses the mock system and gives us the real child_process.
let mockSpawnImpl: ((...args: any[]) => any) | null = null;

mock.module("child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realSpawn = require("child_process").spawn;
  return {
    spawn: (...args: any[]) =>
      mockSpawnImpl ? mockSpawnImpl(...args) : realSpawn(...args),
  };
});

// ── better-sqlite3 mock ───────────────────────────────────────────
mock.module("better-sqlite3", () => ({
  default: class MockDb {
    prepare(_sql: string) {
      return { all: () => mockRows };
    }
    close() {}
  },
}));

// --- cross-image mock ---
globalThis.__crossImageDecodeState = {
  presets: [] as { hash: bigint; width: number; height: number }[],
  index: 0,
};

function makePixelData(hash: bigint): Uint8Array {
  const W = 32;
  const H = 32;
  const pixelCount = W * H;
  const data = new Uint8Array(pixelCount * 4);
  const seed = Number(hash & 0xFFn);
  const pattern = (seed >> 2) & 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const base = x * 3 + y * 7;
      const mod =
        pattern === 0 ? x * 11 :
        pattern === 1 ? y * 13 :
        pattern === 2 ? x * y :
        x * 11 + y * 13;
      const value = (seed + base + mod) % 256;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  return data;
}

mock.module("cross-image", () => ({
  Image: {
    decode: mock(async (_data: Uint8Array) => {
      const state = globalThis.__crossImageDecodeState;
      const preset = state.presets[state.index++] ?? { hash: 0n, width: 100, height: 100 };
      return {
        width: preset.width,
        height: preset.height,
        data: makePixelData(preset.hash),
        resize: mock(function (
          this: { width: number; height: number },
          opts: { width: number; height: number },
        ) {
          this.width = opts.width;
          this.height = opts.height;
          return this;
        }),
      };
    }),
  },
}));

globalThis.__hashMockState = {
  presets: [] as { hash: bigint; width: number; height: number }[],
  index: 0,
};

mock.module("./src/hash", () => ({
  perceptualHash: mock(async (_data: Uint8Array) => {
    const state = globalThis.__hashMockState;
    const preset = state.presets[state.index++] ?? { hash: 0n, width: 100, height: 100 };
    return { hash: preset.hash, width: preset.width, height: preset.height };
  }),
  hammingDistance: (a: bigint, b: bigint) => {
    let xor = a ^ b;
    let count = 0;
    while (xor > 0n) {
      count += Number(xor & 1n);
      xor >>= 1n;
    }
    return count;
  },
  PHASH_THRESHOLD: 10,
}));

mock.module("node:fs", () => {
  const m: Record<string, unknown> = {};
  const noop = () => {};
  m.readFileSync = () => { throw new Error(); };
  m.writeFileSync = noop;
  m.mkdirSync = noop;
  m.default = m;
  return m;
});

import { getDbDir, stripTrackingParams, imageSearchTool, searchCache, searchIdCounters } from "./src/index";

// --- Helpers ---
const encoder = new TextEncoder();
const SESSION = { sessionID: "test-session" };

function imageRecord(url: string, filename: string) {
  return {
    data: JSON.stringify({ type: "file", mime: "image/png", url, filename }),
  };
}

const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function mockFetchOk() {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(MINI_PNG, {
        headers: { "Content-Type": "image/png" },
      }),
    ),
  ) as unknown as typeof globalThis.fetch;
}

interface JsonResult {
  index: number;
  title?: string;
  url?: string;
  thumbnail?: string;
  source?: string;
  size?: string;
  width?: number;
  height?: number;
  similarity?: number;
}

function jsonResponse(engine: string, results: JsonResult[]) {
  return JSON.stringify({ engine, count: results.length, results });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  mockSpawnImpl = null;
  globalThis.fetch = originalFetch;
  globalThis.__crossImageDecodeState.index = 0;
  globalThis.__hashMockState.index = 0;
});

function mockSpawn(jsonResponseStr: string) {
  const proc = {
    stdin: { write: mock(() => {}), end: mock(() => {}) },
    stdout: Readable.from([encoder.encode(jsonResponseStr + "\n")]),
    kill: mock(() => {}),
  };
  mockSpawnImpl = mock(() => proc);
  return proc;
}

// --- Tests ---

describe("getDbDir", () => {
  it("uses .local/share/opencode on non-Windows", () => {
    const dir = getDbDir("linux", undefined, "/home/test");
    expect(dir).toBe("/home/test/.local/share/opencode");
  });

  it("uses APPDATA on Windows", () => {
    const dir = getDbDir("win32", "C:\\Users\\test\\AppData\\Roaming");
    expect(dir).toMatch(/^C:\\Users\\test\\AppData\\Roaming[\\/]opencode$/);
  });

  it("falls back when APPDATA is unset on Windows", () => {
    const dir = getDbDir("win32", undefined);
    expect(dir).toContain("AppData");
    expect(dir).toMatch(/opencode$/i);
  });

  it("defaults to the real platform at runtime", () => {
    const dir = getDbDir();
    if (process.platform === "win32") {
      expect(path.win32.basename(dir)).toBe("opencode");
    } else {
      expect(dir).toMatch(/\/\.local\/share\/opencode$/);
    }
  });
});

describe("image_search", () => {
  beforeEach(() => {
    mockRows = [];
    searchCache.clear();
    searchIdCounters.clear();
    globalThis.__crossImageDecodeState = {
      presets: [],
      index: 0,
    };
    globalThis.__hashMockState = {
      presets: [],
      index: 0,
    };
  });

  it("cross-image mock is active and makePixelData is callable", async () => {
    const { Image } = await import("cross-image");
    globalThis.__crossImageDecodeState.presets = [{ hash: 111n, width: 50, height: 100 }];
    const img = await Image.decode(new Uint8Array(1));
    expect(img.width).toBe(50);
    expect(img.height).toBe(100);
  });

  it("returns message when no images in session", async () => {
    const result = await imageSearchTool.execute({}, SESSION);
    expect(result).toBe("No image attachments found in this session");
  });

  it("filters by filename — no match", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "cat.png"));
    const result = await imageSearchTool.execute({ filename: "dog" }, SESSION);
    expect(result).toMatch(/No image found with filename matching.*dog/i);
  });

  it("filters by filename — case insensitive", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "Cat.PNG"));
    mockSpawn(jsonResponse("Yandex", [{ index: 1, title: "cat result", url: "https://ex.com", thumbnail: "https://ex.com/thumb.jpg" }]));
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];
    mockFetchOk();
    // biome-ignore lint/suspicious/noExplicitAny: structured result
    const result = (await imageSearchTool.execute({ filename: "cat" }, SESSION)) as any;
    expect(result.output).toContain("cat result");
  });

  it("reports index out of range", async () => {
    mockRows.push(
      imageRecord("data:image/png;base64,a", "a.png"),
      imageRecord("data:image/png;base64,b", "b.png"),
    );
    const result = await imageSearchTool.execute({ index: 5 }, SESSION);
    expect(result).toMatch(/Index 5 out of range/);
    expect(result).toContain("2 images available");
  });

  it("reports index out of range with filename context", async () => {
    mockRows.push(
      imageRecord("data:image/png;base64,a", "nope.png"),
      imageRecord("data:image/png;base64,b", "match.png"),
    );
    const result = await imageSearchTool.execute({ filename: "match", index: 2 }, SESSION);
    expect(result).toContain('"match"');
    expect(result).toContain("1 image available");
  });

  it("performs successful search with default engine", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    const proc = mockSpawn(jsonResponse("Yandex", [{ index: 1, title: "found it", url: "https://ex.com", thumbnail: "https://ex.com/thumb.jpg" }]));
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];
    mockFetchOk();
    // biome-ignore lint/suspicious/noExplicitAny: structured result
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.output).toContain("found it");
    expect(mockSpawnImpl).toHaveBeenCalledWith(
      "uv",
      ["run", expect.stringMatching(/search\.py$/)],
      expect.objectContaining({ stdio: ["pipe", "pipe", "inherit"] }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: mock internals
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((s: string) => s.includes("Yandex"))).toBeTrue();
  });

  it("passes custom engine and limit", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    const proc = mockSpawn(jsonResponse("SauceNAO", []));
    await imageSearchTool.execute({ engine: "SauceNAO", limit: 5 }, SESSION);
    // biome-ignore lint/suspicious/noExplicitAny: mock internals
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0]);
    const call = calls.find((s: string) => s.includes("SauceNAO"));
    expect(call).toContain("SauceNAO");
    expect(call).toContain('"limit":5');
  });

  it("selects correct image by index", async () => {
    mockRows.push(
      imageRecord("data:image/png;base64,first", "first.png"),
      imageRecord("data:image/png;base64,second", "second.png"),
    );
    const proc = mockSpawn(jsonResponse("Yandex", [{ index: 1, title: "second", url: "https://ex.com", thumbnail: "" }]));
    await imageSearchTool.execute({ index: 2 }, SESSION);
    // biome-ignore lint/suspicious/noExplicitAny: mock internals
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0]);
    expect(calls.find((s: string) => s.includes("second"))).toContain("second");
  });

  it("kills child process in finally block", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    const proc = mockSpawn(jsonResponse("Yandex", [{ index: 1, title: "ok", url: "https://ex.com", thumbnail: "" }]));
    await imageSearchTool.execute({}, SESSION);
    expect(proc.kill).toHaveBeenCalled();
  });

  it("returns plain text when search has no results", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(JSON.stringify({ engine: "Yandex", count: 0, results: [] }));
    const result = await imageSearchTool.execute({}, SESSION);
    expect(result).toContain("Yandex");
    expect(result).toContain("No results found");
  });

  it("returns error message from search script", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(JSON.stringify({ engine: "Yandex", error: "network error" }));
    const result = await imageSearchTool.execute({}, SESSION);
    expect(result).toContain("Search failed");
    expect(result).toContain("Yandex");
    expect(result).toContain("network error");
  });

  it("returns structured result with image attachments for thumbnail results", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "Result A", url: "https://example.com/a", thumbnail: "https://example.com/a.jpg" },
      { index: 2, title: "Result B", url: "https://example.com/b", thumbnail: "https://example.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xffffffffffffffffn, width: 100, height: 100 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.output).toContain("Search Engine: Yandex");
    expect(result.output).toContain("Result A");
    expect(result.output).toContain("Result B");
    expect(result.output).toContain("Similarity: 100.0%");
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].type).toBe("file");
    expect(result.attachments[0].mime).toBe("image/png");
    expect(result.attachments[0].url).toStartWith("data:image/png;base64,");
    expect(result.attachments[0].filename).toBe("result_1.png");
    expect(result.attachments[1].filename).toBe("result_2.png");
  });

  it("caps attachments to the requested limit", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "R1", url: "https://ex.com/1", thumbnail: "https://example.com/1.jpg" },
      { index: 2, title: "R2", url: "https://ex.com/2", thumbnail: "https://example.com/2.jpg" },
      { index: 3, title: "R3", url: "https://ex.com/3", thumbnail: "https://example.com/3.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [{ hash: 111n, width: 100, height: 100 }];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({ limit: 1 }, SESSION)) as any;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1.png");
    expect(result.output).toContain("R1");
    expect(result.output).toContain("R2"); // text still has all results
    expect(result.output).toContain("R3");
  });

  it("skips thumbnails that fail to download", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "Good", url: "https://ex.com/1", thumbnail: "https://example.com/good.jpg" },
      { index: 2, title: "Bad", url: "https://ex.com/2", thumbnail: "https://example.com/bad.jpg" },
    ]));
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 3) return Promise.reject(new Error("network error"));
      return Promise.resolve(
        new Response(MINI_PNG, {
          headers: { "Content-Type": "image/png" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.output).toContain("Similarity:");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1.png");
  });

  it("deduplicates identical thumbnails into one attachment", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://ex.com/a", thumbnail: "https://example.com/a.jpg" },
      { index: 2, title: "B", url: "https://ex.com/b", thumbnail: "https://example.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 123n, width: 100, height: 100 },
      { hash: 123n, width: 100, height: 100 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1-2.png");
  });

  it("keeps separate attachments for different thumbnails", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://ex.com/a", thumbnail: "https://example.com/a.jpg" },
      { index: 2, title: "B", url: "https://ex.com/b", thumbnail: "https://example.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xffffffffffffffffn, width: 100, height: 100 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].filename).toBe("result_1.png");
    expect(result.attachments[1].filename).toBe("result_2.png");
  });

  it("groups non-consecutive duplicates correctly", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://ex.com/a", thumbnail: "https://example.com/a.jpg" },
      { index: 2, title: "B", url: "https://ex.com/b", thumbnail: "https://example.com/b.jpg" },
      { index: 3, title: "C", url: "https://ex.com/c", thumbnail: "https://example.com/c.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xffffffffffffffffn, width: 100, height: 100 },
      { hash: 0n, width: 100, height: 100 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].filename).toBe("result_1,3.png");
    expect(result.attachments[1].filename).toBe("result_2.png");
  });

  it("picks highest resolution thumbnail from each duplicate group", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "Small", url: "https://ex.com/small", thumbnail: "https://example.com/small.jpg" },
      { index: 2, title: "Large", url: "https://ex.com/large", thumbnail: "https://example.com/large.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 456n, width: 50, height: 50 },
      { hash: 456n, width: 200, height: 200 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.attachments).toHaveLength(1);

    const bytes = Buffer.from(
      result.attachments[0].url.slice("data:image/png;base64,".length),
      "base64",
    );
    expect(bytes).toEqual(MINI_PNG);
  });

  it("groups transitively: A↔B and B↔C but not A↔C are still merged via B", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://ex.com/a", thumbnail: "https://example.com/a.jpg" },
      { index: 2, title: "B", url: "https://ex.com/b", thumbnail: "https://example.com/b.jpg" },
      { index: 3, title: "C", url: "https://ex.com/c", thumbnail: "https://example.com/c.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 50, height: 50 },
      { hash: 1023n, width: 200, height: 200 },
      { hash: 1047552n, width: 100, height: 100 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1-3.png");
  });

  it("populates search cache with page URLs from results", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "R1", url: "https://example.com/page/1", thumbnail: "https://example.com/1.jpg" },
      { index: 2, title: "R2", url: "https://example.com/page/2", thumbnail: "https://example.com/2.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFFFFFFFFFFFn, width: 100, height: 100 },
    ];

    await imageSearchTool.execute({}, SESSION);
    const cacheKey = "test-session::search::1";
    const cached = searchCache.get(cacheKey);
    expect(cached).toBeDefined();
    expect(cached!.results).toHaveLength(2);
    expect(cached!.results[0].pageUrl).toBe("https://example.com/page/1");
    expect(cached!.results[1].pageUrl).toBe("https://example.com/page/2");
  });

  it("formats a run of 5 consecutive duplicates as a range", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://ex.com/a", thumbnail: "https://example.com/a.jpg" },
      { index: 2, title: "B", url: "https://ex.com/b", thumbnail: "https://example.com/b.jpg" },
      { index: 3, title: "C", url: "https://ex.com/c", thumbnail: "https://example.com/c.jpg" },
      { index: 4, title: "D", url: "https://ex.com/d", thumbnail: "https://example.com/d.jpg" },
      { index: 5, title: "E", url: "https://ex.com/e", thumbnail: "https://example.com/e.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: structured result access
    const result = (await imageSearchTool.execute({}, SESSION)) as any;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1-5.png");
  });
});

describe("stripTrackingParams", () => {
  it("removes utm_* parameters", () => {
    const url = "https://example.com/page?utm_source=yandex&utm_medium=organic&q=value";
    const result = stripTrackingParams(url);
    expect(result).toBe("https://example.com/page?q=value");
  });

  it("removes fbclid, gclid, yclid, dclid, msclkid", () => {
    const url = "https://example.com/page?fbclid=abc&gclid=def&yclid=ghi&dclid=jkl&msclkid=mno&keep=stay";
    const result = stripTrackingParams(url);
    expect(result).toBe("https://example.com/page?keep=stay");
  });

  it("removes _openstat and mc_* parameters", () => {
    const url = "https://example.com/page?_openstat=track&mc_cid=123&mc_eid=456&real=param";
    const result = stripTrackingParams(url);
    expect(result).toBe("https://example.com/page?real=param");
  });

  it("returns URL unchanged when no tracking params present", () => {
    const url = "https://example.com/page?q=search&page=1";
    const result = stripTrackingParams(url);
    expect(result).toBe(url);
  });

  it("removes trailing ? when all params are tracking", () => {
    const url = "https://example.com/page?utm_source=yandex";
    const result = stripTrackingParams(url);
    expect(result).toBe("https://example.com/page");
  });

  it("handles URL without query string", () => {
    const url = "https://example.com/page";
    const result = stripTrackingParams(url);
    expect(result).toBe(url);
  });

  it("handles malformed URL gracefully", () => {
    const url = "not a url";
    const result = stripTrackingParams(url);
    expect(result).toBe(url);
  });

  it("handles URL with hash fragment", () => {
    const url = "https://example.com/page?utm_source=yandex#section";
    const result = stripTrackingParams(url);
    expect(result).toBe("https://example.com/page#section");
  });
});

describe("blocklist", () => {
  beforeEach(() => {
    mockRows = [];
    searchCache.clear();
    searchIdCounters.clear();
    globalThis.__crossImageDecodeState = { presets: [], index: 0 };
    globalThis.__hashMockState = { presets: [], index: 0 };
  });

  it("keeps all results when blocklist has no matches", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://ex.com/1", thumbnail: "https://ex.com/a.jpg" },
      { index: 2, title: "B", url: "https://ex.com/2", thumbnail: "https://ex.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFn, width: 100, height: 100 },
    ];
    const result = (await imageSearchTool.execute({ blocklist: ["other.example"] }, SESSION)) as any;
    expect(result.output).toContain("Title: A");
    expect(result.output).toContain("Title: B");
    expect(result.attachments).toHaveLength(2);
  });

  it("removes results from blocklisted domains", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "Keep", url: "https://good.com/1", thumbnail: "https://good.com/a.jpg" },
      { index: 2, title: "Block", url: "https://bad.com/2", thumbnail: "https://bad.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];

    const result = (await imageSearchTool.execute({ blocklist: ["bad.com"] }, SESSION)) as any;
    expect(result.output).toContain("Keep");
    expect(result.output).not.toContain("Block");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1.png");
  });

  it("returns message when all results are blocked", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://bad.com/1", thumbnail: "https://bad.com/a.jpg" },
    ]));
    mockFetchOk();

    const result = await imageSearchTool.execute({ blocklist: ["bad.com"] }, SESSION);
    expect(result).toContain("blocklist");
  });

  it("blocks subdomains of blocklisted domains", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://sub.bad.com/1", thumbnail: "https://sub.bad.com/a.jpg" },
      { index: 2, title: "B", url: "https://good.com/2", thumbnail: "https://good.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];

    const result = (await imageSearchTool.execute({ blocklist: ["bad.com"] }, SESSION)) as any;
    expect(result.output).not.toContain("Title: A");
    expect(result.output).toContain("Title: B");
    expect(result.attachments).toHaveLength(1);
  });

  it("reads blocklist from IMAGE_SEARCH_BLOCKLIST env var", async () => {
    const orig = process.env.IMAGE_SEARCH_BLOCKLIST;
    process.env.IMAGE_SEARCH_BLOCKLIST = "bad.com";
    try {
      mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
      mockSpawn(jsonResponse("Yandex", [
        { index: 1, title: "Keep", url: "https://good.com/1", thumbnail: "https://good.com/a.jpg" },
        { index: 2, title: "Block", url: "https://bad.com/2", thumbnail: "https://bad.com/b.jpg" },
      ]));
      mockFetchOk();
      globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];

      const result = (await imageSearchTool.execute({}, SESSION)) as any;
      expect(result.output).toContain("Keep");
      expect(result.output).not.toContain("Block");
      expect(result.attachments).toHaveLength(1);
    } finally {
      process.env.IMAGE_SEARCH_BLOCKLIST = orig;
    }
  });
});

describe("site filter", () => {
  beforeEach(() => {
    mockRows = [];
    searchCache.clear();
    searchIdCounters.clear();
    globalThis.__crossImageDecodeState = { presets: [], index: 0 };
    globalThis.__hashMockState = { presets: [], index: 0 };
  });

  it("keeps all results when site filter matches all domains", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://good.com/1", thumbnail: "https://good.com/a.jpg" },
      { index: 2, title: "B", url: "https://good.com/2", thumbnail: "https://good.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFn, width: 100, height: 100 },
    ];
    const result = (await imageSearchTool.execute({ site: "good.com" }, SESSION)) as any;
    expect(result.output).toContain("Title: A");
    expect(result.output).toContain("Title: B");
    expect(result.attachments).toHaveLength(2);
  });

  it("filters results to only the matching domain", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "Keep", url: "https://good.com/1", thumbnail: "https://good.com/a.jpg" },
      { index: 2, title: "Drop", url: "https://bad.com/2", thumbnail: "https://bad.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];

    const result = (await imageSearchTool.execute({ site: "good.com" }, SESSION)) as any;
    expect(result.output).toContain("Keep");
    expect(result.output).not.toContain("Drop");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("result_1.png");
  });

  it("matches subdomains of the specified site", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://sub.good.com/1", thumbnail: "https://sub.good.com/a.jpg" },
      { index: 2, title: "B", url: "https://other.com/2", thumbnail: "https://other.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];

    const result = (await imageSearchTool.execute({ site: "good.com" }, SESSION)) as any;
    expect(result.output).toContain("Title: A");
    expect(result.output).not.toContain("Title: B");
    expect(result.attachments).toHaveLength(1);
  });

  it("returns message when all results are filtered by site", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://bad.com/1", thumbnail: "https://bad.com/a.jpg" },
    ]));
    mockFetchOk();

    const result = await imageSearchTool.execute({ site: "good.com" }, SESSION);
    expect(result).toContain("site filter");
  });

  it("site takes precedence over blocklist", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "A", url: "https://good.com/1", thumbnail: "https://good.com/a.jpg" },
      { index: 2, title: "B", url: "https://bad.com/2", thumbnail: "https://bad.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [{ hash: 0n, width: 100, height: 100 }];

    const result = (await imageSearchTool.execute(
      { site: "good.com", blocklist: ["good.com"] },
      SESSION,
    )) as any;
    expect(result.output).toContain("Title: A");
    expect(result.output).not.toContain("Title: B");
  });

  it("keeps results without a URL", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"));
    mockSpawn(jsonResponse("Yandex", [
      { index: 1, title: "No URL", thumbnail: "https://good.com/a.jpg" },
      { index: 2, title: "With URL", url: "https://good.com/2", thumbnail: "https://good.com/b.jpg" },
    ]));
    mockFetchOk();
    globalThis.__hashMockState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFn, width: 100, height: 100 },
    ];

    const result = (await imageSearchTool.execute({ site: "good.com" }, SESSION)) as any;
    expect(result.output).toContain("No URL");
    expect(result.output).toContain("With URL");
    expect(result.attachments).toHaveLength(2);
  });
});

describe("Python script JSON contract", () => {
  it("accepts a data URI via stdin and returns valid JSON output", async () => {
    const dataUri = `data:image/png;base64,${MINI_PNG.toString("base64")}`;
    const { spawn } = await import("child_process");
    const { fileURLToPath } = await import("url");
    const proc = spawn(
      "uv",
      ["run", path.join(path.dirname(fileURLToPath(import.meta.url)), "src/search.py")],
      { stdio: ["pipe", "pipe"] },
    );
    proc.stdin.write(JSON.stringify({
      source: dataUri,
      engine: "Yandex",
      limit: 1,
    }));
    proc.stdin.end();

    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += Buffer.from(chunk as Uint8Array).toString();
    }
    proc.kill();

    expect(() => JSON.parse(buf)).not.toThrow();
    const parsed = JSON.parse(buf);
    // Should have either an error or a valid search response
    expect(parsed.error || parsed.engine).toBeDefined();
    if (parsed.results) {
      expect(parsed.engine).toBe("Yandex");
      expect(typeof parsed.count).toBe("number");
      expect(Array.isArray(parsed.results)).toBeTrue();
    }
  });

  it("reports error for unknown engine", async () => {
    const { spawn } = await import("child_process");
    const { fileURLToPath } = await import("url");
    const proc = spawn(
      "uv",
      ["run", path.join(path.dirname(fileURLToPath(import.meta.url)), "src/search.py")],
      { stdio: ["pipe", "pipe"] },
    );
    proc.stdin.write(JSON.stringify({
      source: "https://example.com/img.jpg",
      engine: "FakeEngine",
      limit: 1,
    }));
    proc.stdin.end();

    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += Buffer.from(chunk as Uint8Array).toString();
    }
    proc.kill();

    const parsed = JSON.parse(buf);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("Unknown engine");
  });
});
