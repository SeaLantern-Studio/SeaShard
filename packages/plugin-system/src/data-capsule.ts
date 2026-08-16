import { defineDataCapsule } from "@seashard/database";

export const pluginSystemDataCapsule = defineDataCapsule({
  namespace: "plugin_system",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: [
    "plugin_packages",
    "plugin_current",
    "plugin_trust",
    "plugin_bindings",
    "plugin_runtime_counters",
    "plugin_runtime_generations",
    "plugin_runtime_publications",
    "plugin_runtime_operations",
    "operation_journal",
  ],
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
        `CREATE TABLE plugin_runtime_counters (
          runtime_id TEXT PRIMARY KEY,
          last_generation INTEGER NOT NULL
        ) STRICT`,
        `CREATE TABLE plugin_runtime_generations (
          runtime_id TEXT NOT NULL,
          plugin_id TEXT NOT NULL,
          plugin_version TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          trust_level TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          phase TEXT NOT NULL,
          upgrade_mode TEXT NOT NULL,
          host_kind TEXT NOT NULL,
          dependencies_json TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (runtime_id, generation)
        ) STRICT`,
        `CREATE TABLE plugin_runtime_publications (
          runtime_id TEXT PRIMARY KEY,
          generation INTEGER,
          epoch INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT`,
        `CREATE TABLE plugin_runtime_operations (
          id TEXT PRIMARY KEY,
          runtime_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          step TEXT NOT NULL,
          current_generation INTEGER,
          candidate_generation INTEGER,
          attention_required INTEGER NOT NULL CHECK (attention_required IN (0, 1)),
          error TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT`,
        `CREATE TABLE operation_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          category TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT`,
        "CREATE INDEX plugin_bindings_plugin_idx ON plugin_bindings(plugin_id)",
        "CREATE INDEX runtime_generations_binding_idx ON plugin_runtime_generations(binding_id, generation)",
        "CREATE INDEX runtime_operations_runtime_idx ON plugin_runtime_operations(runtime_id, started_at)",
        "CREATE INDEX journal_aggregate_idx ON operation_journal(aggregate_id, id)",
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 9 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table'
                   AND name IN (
                     'plugin_packages', 'plugin_current', 'plugin_trust',
                     'plugin_bindings', 'plugin_runtime_counters',
                     'plugin_runtime_generations', 'plugin_runtime_publications',
                     'plugin_runtime_operations', 'operation_journal'
                   )`,
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
    {
      id: "generation.next",
      access: "write",
      result: "get",
      sql: `INSERT INTO plugin_runtime_counters (runtime_id, last_generation)
            VALUES (?, 1)
            ON CONFLICT(runtime_id) DO UPDATE SET
              last_generation = plugin_runtime_counters.last_generation + 1
            RETURNING last_generation`,
    },
    {
      id: "generation.save",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_runtime_generations (
              runtime_id, plugin_id, plugin_version, entry_id, binding_id, source_kind,
              trust_level, scope_type, scope_id, generation, phase, upgrade_mode,
              host_kind, dependencies_json, error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(runtime_id, generation) DO UPDATE SET
              phase = excluded.phase,
              dependencies_json = excluded.dependencies_json,
              error = excluded.error,
              updated_at = excluded.updated_at`,
    },
    {
      id: "generation.list",
      access: "read",
      result: "all",
      sql: `SELECT runtime_id, plugin_id, plugin_version, entry_id, binding_id, source_kind,
                   trust_level, scope_type, scope_id, generation, phase, upgrade_mode,
                   host_kind, dependencies_json, error, created_at, updated_at
              FROM plugin_runtime_generations
             ORDER BY runtime_id, generation`,
    },
    {
      id: "generation.list-by-runtime",
      access: "read",
      result: "all",
      sql: `SELECT runtime_id, plugin_id, plugin_version, entry_id, binding_id, source_kind,
                   trust_level, scope_type, scope_id, generation, phase, upgrade_mode,
                   host_kind, dependencies_json, error, created_at, updated_at
              FROM plugin_runtime_generations
             WHERE runtime_id = ?
             ORDER BY generation`,
    },
    {
      id: "publication.save",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_runtime_publications (runtime_id, generation, epoch, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(runtime_id) DO UPDATE SET
              generation = excluded.generation,
              epoch = excluded.epoch,
              updated_at = excluded.updated_at`,
    },
    {
      id: "publication.list",
      access: "read",
      result: "all",
      sql: `SELECT runtime_id, generation, epoch, updated_at
              FROM plugin_runtime_publications
             ORDER BY runtime_id`,
    },
    {
      id: "publication.invalidate",
      access: "write",
      result: "run",
      sql: `UPDATE plugin_runtime_publications
               SET generation = NULL,
                   epoch = epoch + 1,
                   updated_at = ?
             WHERE generation IS NOT NULL`,
    },
    {
      id: "operation.save",
      access: "write",
      result: "run",
      sql: `INSERT INTO plugin_runtime_operations (
              id, runtime_id, kind, mode, status, step, current_generation,
              candidate_generation, attention_required, error, started_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              step = excluded.step,
              current_generation = excluded.current_generation,
              candidate_generation = excluded.candidate_generation,
              attention_required = excluded.attention_required,
              error = excluded.error,
              updated_at = excluded.updated_at`,
    },
    {
      id: "operation.list",
      access: "read",
      result: "all",
      sql: `SELECT id, runtime_id, kind, mode, status, step, current_generation,
                   candidate_generation, attention_required, error, started_at, updated_at
              FROM plugin_runtime_operations
             ORDER BY started_at, id`,
    },
    {
      id: "operation.list-by-runtime",
      access: "read",
      result: "all",
      sql: `SELECT id, runtime_id, kind, mode, status, step, current_generation,
                   candidate_generation, attention_required, error, started_at, updated_at
              FROM plugin_runtime_operations
             WHERE runtime_id = ?
             ORDER BY started_at, id`,
    },
    {
      id: "operation.interrupt",
      access: "write",
      result: "run",
      sql: `UPDATE plugin_runtime_operations
               SET status = 'interrupted',
                   error = COALESCE(error, 'SeaShard stopped before the operation completed'),
                   updated_at = ?
             WHERE status = 'running'`,
    },
    {
      id: "journal.append",
      access: "write",
      result: "run",
      sql: `INSERT INTO operation_journal (occurred_at, category, aggregate_id, payload_json)
            VALUES (?, ?, ?, ?)`,
    },
    {
      id: "journal.list",
      access: "read",
      result: "all",
      sql: `SELECT id, occurred_at, category, aggregate_id, payload_json
              FROM operation_journal
             WHERE id > ?
             ORDER BY id`,
    },
  ],
});
