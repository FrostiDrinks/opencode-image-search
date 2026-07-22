import { tool } from "@opencode-ai/plugin"
import type { PluginModule, Hooks, ToolAttachment } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import os from "os"
import path from "path"

function writeMsg(
  stdin: { write(data: string): number; flush(): void },
  msg: object,
) {
  stdin.write(JSON.stringify(msg) + "\n")
  stdin.flush()
}

async function readResponse(
  reader: ReadableStreamDefaultReader,
  id: number,
  timeoutMs = 30_000,
): Promise<unknown> {
  const decoder = new TextDecoder()
  let buf = ""

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split("\n")
    buf = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const resp = JSON.parse(trimmed)
        if (resp.id === id) {
          if (resp.error) throw new Error(resp.error.message)
          return resp.result
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
  throw new Error("MCP response timeout or connection closed")
}

export function getDbDir(
  platform = process.platform,
  appData = process.env.APPDATA,
  homeDir = os.homedir(),
): string {
  return platform === "win32"
    ? path.join(appData ?? "C:\\Users\\Default\\AppData\\Roaming", "opencode")
    : path.join(homeDir, ".local/share/opencode")
}

const THUMBNAIL_RE = /^Thumbnail: (.+)$/gm

function extractThumbnails(text: string): string[] {
  const urls: string[] = []
  let match: RegExpExecArray | null
  while ((match = THUMBNAIL_RE.exec(text)) !== null) {
    urls.push(match[1])
  }
  return urls
}

async function fetchImageAsDataUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ mime: string; data: string }> {
  const resp = await fetch(url, { signal })
  const blob = await resp.blob()
  const mime = blob.type || "image/jpeg"
  const buffer = await blob.arrayBuffer()
  const base64 = Buffer.from(buffer).toString("base64")
  return { mime, data: `data:${mime};base64,${base64}` }
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
      .describe("Filter by filename (case-insensitive substring match). Check the conversation for filenames to target a specific image."),
    engine: tool.schema
      .string()
      .optional()
      .describe("Search engine: Yandex (default), SauceNAO, Google, TraceMoe, Ascii2D, EHentai, Iqdb, BaiDu, Bing, GoogleLens, Tineye"),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .default(10)
      .optional()
      .describe("Max number of results (default: 10)"),
  },
  async execute(args, context) {
    const db = new Database(
      path.join(getDbDir(), "opencode.db"),
      { readonly: true },
    )

    let rows: { data: string }[]
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
        .all({ $sessionID: context.sessionID }) as { data: string }[]
    } finally {
      db.close()
    }

    if (rows.length === 0) return "No image attachments found in this session"

    const parts = rows.map((r) => JSON.parse(r.data as string))

    let candidates = parts

    if (args.filename) {
      const q = args.filename.toLowerCase()
      candidates = parts.filter((p: any) =>
        p.filename?.toLowerCase().includes(q),
      )
      if (candidates.length === 0)
        return `No image found with filename matching "${args.filename}"`
    }

    const idx = args.index ?? candidates.length
    if (idx > candidates.length) {
      const total = candidates.length
      return `Index ${idx} out of range. ${args.filename ? `Matching "${args.filename}": ` : ""}${total} image${total > 1 ? "s" : ""} available (1 = first, ${total} = most recent).`
    }

    const source = (candidates[idx - 1] as any).url as string

    const proc = Bun.spawn(["uvx", "image-search-mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    })

    try {
      const reader = proc.stdout.getReader()

      writeMsg(proc.stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "opencode-image-search", version: "1.0" },
        },
      })
      await readResponse(reader, 1)

      writeMsg(proc.stdin, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })

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
      })
      const result = (await readResponse(reader, 2)) as any

      const text =
        result?.content?.[0]?.text ?? JSON.stringify(result)

      const limit = args.limit ?? 10
      const thumbnailUrls = extractThumbnails(text).slice(0, limit)
      if (thumbnailUrls.length === 0) return text

      const attachments: ToolAttachment[] = []
      for (let i = 0; i < thumbnailUrls.length; i++) {
        try {
          const { mime, data } = await fetchImageAsDataUrl(
            thumbnailUrls[i],
            context.abort,
          )
          attachments.push({
            type: "file",
            mime,
            url: data,
            filename: `result_${i + 1}.${mime.split("/")[1] || "jpg"}`,
          })
        } catch {
          // skip thumbnails that fail to download
        }
      }

      return { output: text, attachments }
    } finally {
      proc.kill()
    }
  },
})

export { imageSearchTool }

export default {
  id: "image_search",
  async server(): Promise<Hooks> {
    return {
      tool: {
        image_search: imageSearchTool,
      },
    }
  },
} satisfies PluginModule


