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

const originalSpawn = Bun.spawn

afterEach(() => {
  Bun.spawn = originalSpawn
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
})
