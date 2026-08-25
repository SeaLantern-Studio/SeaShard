import { defineDataCapsule } from "@seashard/database";

/**
 * 插件持久化只保存包、信任、当前版本和用户 Binding。
 * 运行时 Fiber 状态由 Cordis 在进程内维护，不再落库。
 * 未上线项目直接采用当前 schema，旧本地数据库不提供迁移或兼容读取。
 */
export const pluginSystemDataCapsule = defineDataCapsule({
  namespace: "plugin_system",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: ["plugin_packages", "plugin_current", "plugin_trust", "plugin_bindings"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE plugin_packages (
          plugin_id TEXT NOT NULL,
          version TEXT NOT NULL,
          digest TEXT NOT NULL,
          publisher TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          root_path TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          PRIMARY KEY (plugin_id, version, digest)
        ) STRICT`,
        `CREATE TABLE plugin_current (
          plugin_id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          digest TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (plugin_id, version, digest)
            REFERENCES plugin_packages(plugin_id, version, digest) ON DELETE RESTRICT
        ) STRICT`,
        `CREATE TABLE plugin_trust (
          plugin_id TEXT NOT NULL,
          version TEXT NOT NULL,
          digest TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_root TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          PRIMARY KEY (plugin_id, version, digest)
        ) STRICT`,
        `CREATE TABLE plugin_bindings (
          id TEXT PRIMARY KEY,
          plugin_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          config_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT`,
        "CREATE INDEX plugin_bindings_plugin_idx ON plugin_bindings(plugin_id)",
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 4 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table'
                   AND name IN ('plugin_packages', 'plugin_current', 'plugin_trust', 'plugin_bindings')`,
          column: "valid",
          equals: 1,
        },
      ],
    },
  ],
  commands: [
    {
      id: "package.upsert",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_packages (
              plugin_id, version, digest, publisher, source_kind, trust_level,
              root_path, manifest_json, installed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(plugin_id, version, digest) DO UPDATE SET
              source_kind = excluded.source_kind,
              trust_level = excluded.trust_level,
              root_path = excluded.root_path,
              manifest_json = excluded.manifest_json`,
    },
    {
      id: "trust.upsert",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_trust (
              plugin_id, version, digest, source_kind, source_root, trust_level, granted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(plugin_id, version, digest) DO UPDATE SET
              source_kind = excluded.source_kind,
              source_root = excluded.source_root,
              trust_level = excluded.trust_level,
              granted_at = excluded.granted_at`,
    },
    {
      id: "package.current.set",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_current (plugin_id, version, digest, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(plugin_id) DO UPDATE SET
              version = excluded.version,
              digest = excluded.digest,
              updated_at = excluded.updated_at`,
    },
    {
      id: "package.current.clear",
      access: "write",
      result: "run",
      sql: "DELETE FROM plugin_current WHERE plugin_id = ?",
    },
    {
      id: "package.get",
      access: "read",
      result: "get",
      sql: `SELECT plugin_id, version, digest, publisher, source_kind, trust_level,
                   root_path, manifest_json, installed_at
              FROM plugin_packages
             WHERE plugin_id = ? AND version = ? AND digest = ?`,
    },
    {
      id: "package.list",
      access: "read",
      result: "all",
      sql: `SELECT plugin_id, version, digest, publisher, source_kind, trust_level,
                   root_path, manifest_json, installed_at
              FROM plugin_packages
             ORDER BY plugin_id, installed_at, version, digest`,
    },
    {
      id: "package.list-by-plugin",
      access: "read",
      result: "all",
      sql: `SELECT plugin_id, version, digest, publisher, source_kind, trust_level,
                   root_path, manifest_json, installed_at
              FROM plugin_packages
             WHERE plugin_id = ?
             ORDER BY installed_at, version, digest`,
    },
    {
      id: "package.list-current",
      access: "read",
      result: "all",
      sql: `SELECT p.plugin_id, p.version, p.digest, p.publisher, p.source_kind,
                   p.trust_level, p.root_path, p.manifest_json, p.installed_at
              FROM plugin_current AS c
              JOIN plugin_packages AS p
                ON p.plugin_id = c.plugin_id
               AND p.version = c.version
               AND p.digest = c.digest
             ORDER BY p.plugin_id`,
    },
    {
      id: "package.current-is",
      access: "read",
      result: "get",
      sql: `SELECT 1 AS present
              FROM plugin_current
             WHERE plugin_id = ? AND version = ? AND digest = ?`,
    },
    {
      id: "package.delete",
      access: "write",
      result: "run",
      sql: `DELETE FROM plugin_packages
             WHERE plugin_id = ? AND version = ? AND digest = ?`,
    },
    {
      id: "binding.upsert",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_bindings (
              id, plugin_id, entry_id, scope_type, scope_id, enabled, config_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              plugin_id = excluded.plugin_id,
              entry_id = excluded.entry_id,
              scope_type = excluded.scope_type,
              scope_id = excluded.scope_id,
              enabled = excluded.enabled,
              config_json = excluded.config_json,
              updated_at = excluded.updated_at`,
    },
    {
      id: "binding.insert",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_bindings (
              id, plugin_id, entry_id, scope_type, scope_id, enabled, config_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    },
    {
      id: "binding.delete-by-plugin-prefix",
      access: "write",
      result: "run",
      sql: `DELETE FROM plugin_bindings
             WHERE plugin_id = ?1
               AND substr(id, 1, length(?2)) = ?2`,
    },
    {
      id: "binding.delete",
      access: "write",
      result: "run",
      sql: "DELETE FROM plugin_bindings WHERE id = ?",
    },
    {
      id: "binding.list",
      access: "read",
      result: "all",
      sql: `SELECT id, plugin_id, entry_id, scope_type, scope_id, enabled, config_json
              FROM plugin_bindings
             ORDER BY id`,
    },
    {
      id: "binding.list-by-plugin",
      access: "read",
      result: "all",
      sql: `SELECT id, plugin_id, entry_id, scope_type, scope_id, enabled, config_json
              FROM plugin_bindings
             WHERE plugin_id = ?
             ORDER BY id`,
    },
  ],
});
