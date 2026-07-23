import path from "path"
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

// --- Mock schema chain helpers ---
function desc() {
  return {} as any
}
function opt() {
  return { describe: desc }
}
function def() {
  return { optional: opt }
}
function pos() {
  return { optional: opt, default: def }
}
function int() {
  return { positive: pos }
}

mock.module("@opencode-ai/plugin", () => {
  const tool = Object.assign((cfg: any) => cfg, {
    schema: {
      number: () => ({ int }),
      string: () => ({ optional: opt }),
    },
  })
  return { default: tool, tool }
})

let mockRows: { data: string }[] = []

mock.module("bun:sqlite", () => ({
  Database: class MockDb {
    constructor(_p: string, _o: any) {}
    query(_sql: string) {
      return { all: () => mockRows }
    }
    close() {}
  },
}))

// --- cross-image mock ---
;(globalThis as any).__crossImageDecodeState = {
  presets: [] as { hash: bigint; width: number; height: number }[],
  index: 0,
}

function makePixelData(hash: bigint): Uint8Array {
  const pixelCount = 9 * 8
  const data = new Uint8Array(pixelCount * 4)
  for (let y = 0; y < 8; y++) {
    let value = 150
    for (let x = 0; x < 9; x++) {
      const idx = (y * 9 + x) * 4
      if (x > 0) {
        const bit = (hash >> BigInt(y * 8 + (x - 1))) & 1n
        value += bit === 1n ? -10 : 10
      }
      const clamped = Math.max(0, Math.min(255, value))
      data[idx] = clamped
      data[idx + 1] = clamped
      data[idx + 2] = clamped
      data[idx + 3] = 255
    }
  }
  return data
}

mock.module("cross-image", () => ({
  Image: {
    decode: mock(async (_data: Uint8Array) => {
      const state = (globalThis as any).__crossImageDecodeState
      const preset = state.presets[state.index++] ?? { hash: 0n, width: 100, height: 100 }
      return {
        width: preset.width,
        height: preset.height,
        data: makePixelData(preset.hash),
        resize: mock(function (this: any, opts: any) {
          this.width = opts.width
          this.height = opts.height
          return this
        }),
      }
    }),
  },
}))

import { imageSearchTool, getDbDir } from "./src/index"

// --- Helpers ---
const encoder = new TextEncoder()
const SESSION = { sessionID: "test-session" }

function imageRecord(url: string, filename: string) {
  return {
    data: JSON.stringify({ type: "file", mime: "image/png", url, filename }),
  }
}

const mcpInit =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "img", version: "1" },
    },
  }) + "\n"

function mcpResult(text: string) {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text }] },
    }) + "\n"
  )
}

const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

function mockFetchOk() {
  globalThis.fetch = mock(
    () =>
      Promise.resolve(
        new Response(MINI_PNG, {
          headers: { "Content-Type": "image/png" },
        }),
      ),
  ) as any
}

function mcpResultWithThumbnails(
  engine: string,
  results: { title: string; thumbnail: string }[],
) {
  const lines = [`Search Engine: ${engine}`, `Found ${results.length} results (showing top ${results.length}):`]
  results.forEach((r, i) => {
    lines.push("", `--- Result ${i + 1} ---`, `Title: ${r.title}`, `Thumbnail: ${r.thumbnail}`)
  })
  return mcpResult(lines.join("\n"))
}

const originalSpawn = Bun.spawn
const originalFetch = globalThis.fetch

afterEach(() => {
  Bun.spawn = originalSpawn
  globalThis.fetch = originalFetch
  ;(globalThis as any).__crossImageDecodeState.index = 0
})

function mockSpawn(responses: string[]) {
  let i = 0
  const read = mock(() => {
    if (i < responses.length) {
      return Promise.resolve({ value: encoder.encode(responses[i++]), done: false })
    }
    return Promise.resolve({ done: true })
  })
  const proc = {
    stdin: { write: mock(() => {}), flush: mock(() => {}) },
    stdout: { getReader: () => ({ read }) },
    kill: mock(() => {}),
  }
  Bun.spawn = mock(() => proc)
  return proc
}

// --- Tests ---

describe("getDbDir", () => {
  it("uses .local/share/opencode on non-Windows", () => {
    const dir = getDbDir("linux", undefined, "/home/test")
    expect(dir).toBe("/home/test/.local/share/opencode")
  })

  it("uses APPDATA on Windows", () => {
    const dir = getDbDir("win32", "C:\\Users\\test\\AppData\\Roaming")
    expect(dir).toMatch(/^C:\\Users\\test\\AppData\\Roaming[\\/]opencode$/)
  })

  it("falls back when APPDATA is unset on Windows", () => {
    const dir = getDbDir("win32", undefined)
    expect(dir).toContain("AppData")
    expect(dir).toMatch(/opencode$/i)
  })

  it("defaults to the real platform at runtime", () => {
    const dir = getDbDir()
    if (process.platform === "win32") {
      expect(path.win32.basename(dir)).toBe("opencode")
    } else {
      expect(dir).toMatch(/\/\.local\/share\/opencode$/)
    }
  })
})

describe("image_search", () => {
  beforeEach(() => {
    mockRows = []
    ;(globalThis as any).__crossImageDecodeState = {
      presets: [],
      index: 0,
    }
  })

  it("cross-image mock is active and makePixelData is callable", async () => {
    const { Image } = await import("cross-image")
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 111n, width: 50, height: 100 },
    ]
    const img = await Image.decode(new Uint8Array(1))
    expect(img.width).toBe(50)
    expect(img.height).toBe(100)
  })

  it("returns message when no images in session", async () => {
    const result = await imageSearchTool.execute({}, SESSION)
    expect(result).toBe("No image attachments found in this session")
  })

  it("filters by filename — no match", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "cat.png"))
    const result = await imageSearchTool.execute({ filename: "dog" }, SESSION)
    expect(result).toMatch(/No image found with filename matching.*dog/i)
  })

  it("filters by filename — case insensitive", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "Cat.PNG"))
    mockSpawn([mcpInit, mcpResult("cat result")])
    const result = await imageSearchTool.execute({ filename: "cat" }, SESSION)
    expect(result).toBe("cat result")
  })

  it("reports index out of range", async () => {
    mockRows.push(
      imageRecord("data:image/png;base64,a", "a.png"),
      imageRecord("data:image/png;base64,b", "b.png"),
    )
    const result = await imageSearchTool.execute({ index: 5 }, SESSION)
    expect(result).toMatch(/Index 5 out of range/)
    expect(result).toContain("2 images available")
  })

  it("reports index out of range with filename context", async () => {
    mockRows.push(
      imageRecord("data:image/png;base64,a", "nope.png"),
      imageRecord("data:image/png;base64,b", "match.png"),
    )
    const result = await imageSearchTool.execute(
      { filename: "match", index: 2 },
      SESSION,
    )
    expect(result).toContain('"match"')
    expect(result).toContain("1 image available")
  })

  it("performs successful search with default engine", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    const proc = mockSpawn([mcpInit, mcpResult("found it")])
    const result = await imageSearchTool.execute({}, SESSION)
    expect(result).toBe("found it")
    expect(Bun.spawn).toHaveBeenCalledWith(
      ["uvx", "image-search-mcp"],
      expect.objectContaining({ stdin: "pipe", stdout: "pipe" }),
    )
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0])
    expect(calls.some((s: string) => s.includes("tools/call"))).toBeTrue()
    expect(calls.find((s: string) => s.includes("tools/call"))).toContain("Yandex")
  })

  it("defaults limit to 10 when omitted", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    const proc = mockSpawn([mcpInit, mcpResult("ok")])
    await imageSearchTool.execute({}, SESSION)
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0])
    const call = calls.find((s: string) => s.includes("tools/call"))
    expect(call).toContain('"limit":10')
  })

  it("passes custom engine and limit", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    const proc = mockSpawn([mcpInit, mcpResult("sauce")])
    await imageSearchTool.execute({ engine: "SauceNAO", limit: 5 }, SESSION)
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0])
    const call = calls.find((s: string) => s.includes("tools/call"))
    expect(call).toContain("SauceNAO")
    expect(call).toContain('"limit":5')
  })

  it("selects correct image by index", async () => {
    mockRows.push(
      imageRecord("data:image/png;base64,first", "first.png"),
      imageRecord("data:image/png;base64,second", "second.png"),
    )
    const proc = mockSpawn([mcpInit, mcpResult("second")])
    await imageSearchTool.execute({ index: 2 }, SESSION)
    const calls = (proc.stdin.write as any).mock.calls.map((c: string[]) => c[0])
    expect(
      calls.find((s: string) => s.includes("tools/call")),
    ).toContain("second")
  })

  it("kills child process in finally block", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    const proc = mockSpawn([mcpInit, mcpResult("ok")])
    await imageSearchTool.execute({}, SESSION)
    expect(proc.kill).toHaveBeenCalled()
  })

  it("returns plain string when MCP response has no Thumbnail lines", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([mcpInit, mcpResult("no images found")])
    const result = await imageSearchTool.execute({}, SESSION)
    expect(result).toBe("no images found")
  })

  it("returns structured result with image attachments for thumbnail results", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "Result A", thumbnail: "https://example.com/a.jpg" },
        { title: "Result B", thumbnail: "https://example.com/b.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFFFFFFFFFFFn, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.output).toContain("Search Engine: Yandex")
    expect(result.output).toContain("Result A")
    expect(result.output).toContain("Result B")
    expect(result.attachments).toHaveLength(2)
    expect(result.attachments[0].type).toBe("file")
    expect(result.attachments[0].mime).toBe("image/png")
    expect(result.attachments[0].url).toStartWith("data:image/png;base64,")
    expect(result.attachments[0].filename).toBe("result-1.png")
    expect(result.attachments[1].filename).toBe("result-2.png")
  })

  it("caps attachments to the requested limit", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "R1", thumbnail: "https://example.com/1.jpg" },
        { title: "R2", thumbnail: "https://example.com/2.jpg" },
        { title: "R3", thumbnail: "https://example.com/3.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 111n, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({ limit: 1 }, SESSION) as any
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe("result-1.png")
    expect(result.output).toContain("R1")
    expect(result.output).toContain("R2") // text still has all results
    expect(result.output).toContain("R3")
  })

  it("skips thumbnails that fail to download", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "Good", thumbnail: "https://example.com/good.jpg" },
        { title: "Bad", thumbnail: "https://example.com/bad.jpg" },
      ]),
    ])
    let callCount = 0
    globalThis.fetch = mock(() => {
      callCount++
      if (callCount === 2) return Promise.reject(new Error("network error"))
      return Promise.resolve(
        new Response(MINI_PNG, {
          headers: { "Content-Type": "image/png" },
        }),
      )
    }) as any

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe("result-1.png")
  })

  it("deduplicates identical thumbnails into one attachment", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "A", thumbnail: "https://example.com/a.jpg" },
        { title: "B", thumbnail: "https://example.com/b.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 123n, width: 100, height: 100 },
      { hash: 123n, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe("result-1-2.png")
  })

  it("keeps separate attachments for different thumbnails", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "A", thumbnail: "https://example.com/a.jpg" },
        { title: "B", thumbnail: "https://example.com/b.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFFFFFFFFFFFn, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(2)
    expect(result.attachments[0].filename).toBe("result-1.png")
    expect(result.attachments[1].filename).toBe("result-2.png")
  })

  it("groups non-consecutive duplicates correctly", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "A", thumbnail: "https://example.com/a.jpg" },
        { title: "B", thumbnail: "https://example.com/b.jpg" },
        { title: "C", thumbnail: "https://example.com/c.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 0n, width: 100, height: 100 },
      { hash: 0xFFFFFFFFFFFFFFFFn, width: 100, height: 100 },
      { hash: 0n, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(2)
    expect(result.attachments[0].filename).toBe("result-1,3.png")
    expect(result.attachments[1].filename).toBe("result-2.png")
  })

  it("picks highest resolution thumbnail from each duplicate group", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "Small", thumbnail: "https://example.com/small.jpg" },
        { title: "Large", thumbnail: "https://example.com/large.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 456n, width: 50, height: 50 },
      { hash: 456n, width: 200, height: 200 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(1)

    const bytes = Buffer.from(
      result.attachments[0].url.slice("data:image/png;base64,".length),
      "base64",
    )
    expect(bytes).toEqual(MINI_PNG)
  })

  it("groups transitively: A↔B and B↔C but not A↔C are still merged via B", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "A", thumbnail: "https://example.com/a.jpg" },
        { title: "B", thumbnail: "https://example.com/b.jpg" },
        { title: "C", thumbnail: "https://example.com/c.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 0n, width: 50, height: 50 },
      { hash: 1023n, width: 200, height: 200 },
      { hash: 1047552n, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe("result-1-3.png")
  })

  it("formats a run of 5 consecutive duplicates as a range", async () => {
    mockRows.push(imageRecord("data:image/png;base64,a", "test.png"))
    mockSpawn([
      mcpInit,
      mcpResultWithThumbnails("Yandex", [
        { title: "A", thumbnail: "https://example.com/a.jpg" },
        { title: "B", thumbnail: "https://example.com/b.jpg" },
        { title: "C", thumbnail: "https://example.com/c.jpg" },
        { title: "D", thumbnail: "https://example.com/d.jpg" },
        { title: "E", thumbnail: "https://example.com/e.jpg" },
      ]),
    ])
    mockFetchOk()
    ;(globalThis as any).__crossImageDecodeState.presets = [
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
      { hash: 999n, width: 100, height: 100 },
    ]

    const result = await imageSearchTool.execute({}, SESSION) as any
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe("result-1-5.png")
  })
})
