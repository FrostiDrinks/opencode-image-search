// Uses bun:sqlite when running in Bun, falls back to better-sqlite3
// in Node.js (e.g. opencode-desktop). Both APIs are normalized to a
// common interface. Async work is avoided at module evaluation time
// to avoid unhandled rejections in Electron.
interface Db {
  prepare(sql: string): { all(params?: Record<string, unknown>): Record<string, unknown>[] };
  close(): void;
}

let factory: ((path: string) => Db) | undefined;
let initPromise: Promise<void> | undefined;

async function init(): Promise<void> {
  if (factory) return;

  try {
    // Try Bun's built-in sqlite first
    const { Database } = await import("bun:sqlite");
    factory = (path: string): Db => {
      const db = new Database(path, { readonly: true });
      return {
        prepare: (sql: string) => ({
          all: (params?: Record<string, unknown>) => {
            // bun:sqlite expects $ prefix on bind param keys
            const bunParams: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(params ?? {})) {
              bunParams[`$${key}`] = val;
            }
            return (db as unknown as { query(sql: string): { all(p: Record<string, unknown>): Record<string, unknown>[] } })
              .query(sql)
              .all(bunParams);
          },
        }),
        close: () => db.close(),
      };
    };
  } catch {
    // Fall back to better-sqlite3 (Node.js / desktop)
    try {
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
    } catch {
      // Neither bun:sqlite nor better-sqlite3 available
      factory = () => {
        throw new Error(
          "No SQLite library available. Install better-sqlite3 for Node.js " +
            "or use Bun for bun:sqlite.",
        );
      };
    }
  }
}

export async function openDb(path: string): Promise<Db> {
  if (!initPromise) {
    initPromise = init();
  }
  await initPromise;
  return factory!(path);
}