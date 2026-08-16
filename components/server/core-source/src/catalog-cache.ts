import {
  defineDataCapsule,
  type DatabaseRow,
  type RegisteredDataCapsule,
} from "@seashard/database";

interface CatalogCacheRow extends DatabaseRow {
  body_json: string;
  etag: string | null;
  last_modified: string | null;
  fetched_at: string;
}

export interface CnbCatalogCacheRecord {
  readonly body: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly fetchedAt: string;
}

/** CNB 目录缓存边界；生产实现落在用户数据目录的核心 SQLite 数据库中。 */
export interface CnbCatalogCache {
  load(catalogUrl: string): Promise<CnbCatalogCacheRecord | undefined>;
  store(catalogUrl: string, record: CnbCatalogCacheRecord): Promise<void>;
  touch(catalogUrl: string, fetchedAt: string): Promise<void>;
}

/** 服务端核心源组件在核心 SQLite 数据库中拥有的独立 Data Capsule。 */
export const serverCoreSourceCatalogDataCapsule = defineDataCapsule({
  namespace: "server_core_source",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: ["server_core_catalog_cache"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE server_core_catalog_cache (
          catalog_url TEXT PRIMARY KEY NOT NULL,
          body_json TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          fetched_at TEXT NOT NULL
        ) STRICT`,
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_core_catalog_cache'`,
          column: "valid",
          equals: 1,
        },
      ],
    },
  ],
  commands: [
    {
      id: "catalog.get",
      access: "read",
      result: "get",
      sql: `SELECT body_json, etag, last_modified, fetched_at
              FROM server_core_catalog_cache
             WHERE catalog_url = ?`,
    },
    {
      id: "catalog.put",
      access: "write",
      result: "run",
      sql: `INSERT INTO server_core_catalog_cache (
              catalog_url, body_json, etag, last_modified, fetched_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(catalog_url) DO UPDATE SET
              body_json = excluded.body_json,
              etag = excluded.etag,
              last_modified = excluded.last_modified,
              fetched_at = excluded.fetched_at`,
    },
    {
      id: "catalog.touch",
      access: "write",
      result: "run",
      sql: `UPDATE server_core_catalog_cache
               SET fetched_at = ?
             WHERE catalog_url = ?`,
    },
  ],
});

/** 使用类型化命令读写 CNB 目录，不向组件暴露任意 SQL。 */
export class SQLiteCnbCatalogCache implements CnbCatalogCache {
  constructor(private readonly repository: RegisteredDataCapsule) {}

  async load(catalogUrl: string): Promise<CnbCatalogCacheRecord | undefined> {
    const result = await this.repository.execute("catalog.get", [catalogUrl]);
    if (result.kind !== "get") throw unexpectedResult("catalog.get", result.kind);
    if (!result.row) return undefined;
    const row = result.row as CatalogCacheRow;
    return {
      body: expectString(row.body_json, "body_json"),
      fetchedAt: expectString(row.fetched_at, "fetched_at"),
      ...(row.etag === null ? {} : { etag: expectString(row.etag, "etag") }),
      ...(row.last_modified === null
        ? {}
        : { lastModified: expectString(row.last_modified, "last_modified") }),
    };
  }

  async store(catalogUrl: string, record: CnbCatalogCacheRecord): Promise<void> {
    const result = await this.repository.execute("catalog.put", [
      catalogUrl,
      record.body,
      record.etag ?? null,
      record.lastModified ?? null,
      record.fetchedAt,
    ]);
    if (result.kind !== "run") throw unexpectedResult("catalog.put", result.kind);
  }

  async touch(catalogUrl: string, fetchedAt: string): Promise<void> {
    const result = await this.repository.execute("catalog.touch", [fetchedAt, catalogUrl]);
    if (result.kind !== "run") throw unexpectedResult("catalog.touch", result.kind);
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`server core source catalog cache has invalid ${field}`);
  }
  return value;
}

function unexpectedResult(command: string, kind: string): Error {
  return new Error(`database command ${command} returned unexpected ${kind} result`);
}
