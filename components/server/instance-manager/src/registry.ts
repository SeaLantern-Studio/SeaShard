import {
  defineDataCapsule,
  type DatabaseRow,
  type RegisteredDataCapsule,
} from "@seashard/database";

interface ServerInstanceManifestPathRow extends DatabaseRow {
  manifest_path: string;
}

/** 服务器实例组件拥有的 SQLite 路径索引 Data Capsule。 */
export const serverInstanceDataCapsule = defineDataCapsule({
  namespace: "server_instance_manager",
  schemaVersion: 2,
  compatibilityFloor: 2,
  tables: ["server_instances", "server_instance_manifest_index"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE server_instances (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL UNIQUE,
          root_path TEXT NOT NULL,
          root_path_key TEXT NOT NULL UNIQUE,
          core_jar_path TEXT NOT NULL,
          icon_path TEXT,
          storage_mode TEXT NOT NULL CHECK (storage_mode IN ('managed', 'external')),
          source TEXT NOT NULL CHECK (source IN ('downloaded', 'imported')),
          server_type TEXT,
          game_version TEXT,
          artifact_sha256 TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_started_at TEXT
        ) STRICT`,
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_instances'`,
          column: "valid",
          equals: 1,
        },
      ],
    },
    {
      version: 2,
      statements: [
        `CREATE TABLE server_instance_manifest_index (
          manifest_path TEXT PRIMARY KEY NOT NULL
        ) STRICT`,
        `INSERT INTO server_instance_manifest_index (manifest_path)
         SELECT root_path || '/.server-info/seashard.json'
           FROM server_instances`,
        "DROP TABLE server_instances",
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_instance_manifest_index'`,
          column: "valid",
          equals: 1,
        },
        {
          sql: `SELECT COUNT(*) = 0 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_instances'`,
          column: "valid",
          equals: 1,
        },
      ],
    },
  ],
  commands: [
    {
      id: "manifest.list",
      access: "read",
      result: "all",
      sql: `SELECT manifest_path
              FROM server_instance_manifest_index
             ORDER BY manifest_path ASC`,
    },
    {
      id: "manifest.insert",
      access: "write",
      result: "run",
      sql: `INSERT INTO server_instance_manifest_index (manifest_path)
            VALUES (?)`,
    },
  ],
});

/** SQLite 只维护 seashard.json 路径；任何实例字段均不写入数据库。 */
export class SQLiteServerInstanceRegistry {
  constructor(private readonly repository: RegisteredDataCapsule) {}

  async listManifestPaths(): Promise<readonly string[]> {
    const result = await this.repository.execute("manifest.list");
    if (result.kind !== "all") throw unexpectedResult("manifest.list", result.kind);
    return result.rows.map((row) =>
      expectString((row as ServerInstanceManifestPathRow).manifest_path, "manifest_path"),
    );
  }

  async insertManifestPath(manifestPath: string): Promise<void> {
    const result = await this.repository.execute("manifest.insert", [manifestPath]);
    if (result.kind !== "run") throw unexpectedResult("manifest.insert", result.kind);
  }
}

/** 名称按 Unicode 兼容形式和大小写去重，避免 Windows 上出现视觉重复实例。 */
export function instanceNameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`server instance registry has invalid ${field}`);
  }
  return value;
}

function unexpectedResult(command: string, kind: string): Error {
  return new Error(`database command ${command} returned unexpected ${kind} result`);
}
