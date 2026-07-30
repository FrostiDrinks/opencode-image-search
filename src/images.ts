import type { ToolAttachment } from "@opencode-ai/plugin";
import os from "node:os";
import path from "node:path";

type FilePart = ToolAttachment;

export function getDbDir(
  platform = process.platform,
  appData = process.env.APPDATA,
  homeDir = os.homedir(),
): string {
  return platform === "win32"
    ? path.join(appData ?? "C:\\Users\\Default\\AppData\\Roaming", "opencode")
    : path.join(homeDir, ".local/share/opencode");
}

export async function findSessionImages(context: {
  sessionID: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages?: any[];
}): Promise<FilePart[] | null> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(getDbDir(), "opencode.db"), {
      readonly: true,
    });
    try {
      const rows = db
        .query(
          `SELECT p.data
           FROM part p
           WHERE p.session_id = $sessionID
             AND json_extract(p.data, '$.type') = 'file'
             AND json_extract(p.data, '$.mime') LIKE 'image/%'
           ORDER BY p.id ASC`,
        )
        .all({ $sessionID: context.sessionID }) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data)) as FilePart[];
    } finally {
      db.close();
    }
  } catch {
    const msgs = context.messages;
    if (!msgs) return null;

    const parts: FilePart[] = [];
    for (const msg of msgs) {
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        if (
          part.type === "file" &&
          typeof part.mime === "string" &&
          part.mime.startsWith("image/")
        ) {
          parts.push({
            type: "file" as const,
            mime: part.mime as string,
            url: (part.url as string) ?? "",
            filename: part.filename as string | undefined,
          });
        }
      }
    }
    return parts;
  }
}