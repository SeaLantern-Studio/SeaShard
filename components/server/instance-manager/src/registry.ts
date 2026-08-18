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
  namespace: "server_instance_registry",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: ["server_instance_manifests"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE server_instance_manifests (
          manifest_path TEXT PRIMARY KEY NOT NULL
        ) STRICT`,
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_instance_manifests'`,
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
              FROM server_instance_manifests
             ORDER BY manifest_path ASC`,
    },
    {
      id: "manifest.insert",
      access: "write",
      result: "run",
      sql: `INSERT INTO server_instance_manifests (manifest_path)
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
