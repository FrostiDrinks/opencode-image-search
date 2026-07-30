// ── Cross-runtime SQLite adapter ──────────────────────────────────
//
// Uses bun:sqlite when running in Bun, falls back to better-sqlite3
// in Node.js (e.g. opencode-desktop). Both APIs are normalized to a
// common interface.

interface Db {
  prepare(sql: string): { all(params?: Record<string, unknown>): Record<string, unknown>[] };
  close(): void;
}

let factory: ((path: string) => Db) | undefined;

async function init(): Promise<void> {
  if (factory) return;

  try {
    // Try Bun's built-in sqlite first
    const { Database } = await import("bun:sqlite");
    factory = (path: string): Db => {
      const db = new Database(path, { readonly: true });
      return {
        prepare: (sql: string) => ({
          all: (params?: Record<string, unknown>) =>
            (db as unknown as { query(sql: string): { all(p: Record<string, unknown>): Record<string, unknown>[] } })
              .query(sql)
              .all(params ?? {}),
        }),
        close: () => db.close(),
      };
    };
  } catch {
    // Fall back to better-sqlite3 (Node.js / desktop)
    const { default: Database } = await import("better-sqlite3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DBClass = Database as unknown as new (path: string, opts?: { readonly?: boolean }) => any;
    factory = (path: string): Db => {
      const db = new DBClass(path, { readonly: true });
      return {
        prepare: (sql: string) => ({
          all: (params?: Record<string, unknown>) => db.prepare(sql).all(params ?? {}),
        }),
        close: () => db.close(),
      };
    };
  }
}

const initPromise = init();

export async function openDb(path: string): Promise<Db> {
  await initPromise;
  return factory!(path);
}