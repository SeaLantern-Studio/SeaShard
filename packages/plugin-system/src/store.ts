import type {
  JsonValue,
  PluginBinding,
  PluginSourceKind,
  PluginTrustLevel,
  RuntimeGenerationSnapshot,
  RuntimeOperationSnapshot,
  RuntimePublicationSnapshot,
} from "@seashard/plugin-sdk";
import { DatabaseSync } from "node:sqlite";
import { parsePluginManifest } from "./manifest";
import type {
  JournalRecord,
  PluginPackageRecord,
  StoredRuntimeGeneration,
  StoredRuntimeOperation,
  StoredRuntimePublication,
} from "./types";

interface PackageRow {
  plugin_id: string;
  version: string;
  digest: string;
  publisher: string;
  source_kind: PluginSourceKind;
  trust_level: PluginTrustLevel;
  root_path: string;
  manifest_json: string;
  installed_at: string;
}

interface BindingRow {
  id: string;
  plugin_id: string;
  entry_id: string;
  scope_type: PluginBinding["scopeType"];
  scope_id: string;
  enabled: number;
  config_json: string;
}

interface GenerationRow {
  runtime_id: string;
  plugin_id: string;
  plugin_version: string;
  entry_id: string;
  binding_id: string;
  source_kind: RuntimeGenerationSnapshot["source"];
  trust_level: RuntimeGenerationSnapshot["trust"];
  scope_type: RuntimeGenerationSnapshot["scopeType"];
  scope_id: string;
  generation: number;
  phase: RuntimeGenerationSnapshot["phase"];
  upgrade_mode: RuntimeGenerationSnapshot["upgradeMode"];
  host_kind: RuntimeGenerationSnapshot["host"];
  dependencies_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface PublicationRow {
  runtime_id: string;
  generation: number | null;
  epoch: number;
  updated_at: string;
}

interface OperationRow {
  id: string;
  runtime_id: string;
  kind: RuntimeOperationSnapshot["kind"];
  mode: RuntimeOperationSnapshot["mode"];
  status: RuntimeOperationSnapshot["status"];
  step: RuntimeOperationSnapshot["step"];
  current_generation: number | null;
  candidate_generation: number | null;
  attention_required: number;
  error: string | null;
  started_at: string;
  updated_at: string;
}

interface StoredManifestRow {
  plugin_id: string;
  version: string;
  digest: string;
  manifest_json: string;
}

interface JournalRow {
  id: number;
  occurred_at: string;
  category: string;
  aggregate_id: string;
  payload_json: string;
}

export class PluginStore {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly seaShardVersion: string,
  ) {
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
      defensive: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  registerPackage(record: PluginPackageRecord): void {
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO plugin_packages (
             plugin_id, version, digest, publisher, source_kind, trust_level,
             root_path, manifest_json, installed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(plugin_id, version, digest) DO UPDATE SET
             source_kind = excluded.source_kind,
             trust_level = excluded.trust_level,
             root_path = excluded.root_path,
             manifest_json = excluded.manifest_json`,
        )
        .run(
          record.manifest.id,
          record.manifest.version,
          record.digest,
          record.manifest.publisher,
          record.source,
          record.trust,
          record.rootPath,
          JSON.stringify(record.manifest),
          record.installedAt,
        );
      this.appendJournalInternal("plugin.package.registered", record.manifest.id, {
        version: record.manifest.version,
        digest: record.digest,
        source: record.source,
        trust: record.trust,
      });
    });
  }

  grantTrust(record: PluginPackageRecord): void {
    this.database
      .prepare(
        `INSERT INTO plugin_trust (
           plugin_id, version, digest, source_kind, source_root, trust_level, granted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, version, digest) DO UPDATE SET
           source_kind = excluded.source_kind,
           source_root = excluded.source_root,
           trust_level = excluded.trust_level,
           granted_at = excluded.granted_at`,
      )
      .run(
        record.manifest.id,
        record.manifest.version,
        record.digest,
        record.source,
        record.rootPath,
        record.trust,
        record.installedAt,
      );
  }

  setCurrentVersion(pluginId: string, version: string, digest: string): void {
    this.transaction(() => {
      const record = this.getPackage(pluginId, version, digest);
      if (!record)
        throw new Error(`plugin package not installed: ${pluginId}@${version}#${digest}`);
      this.database
        .prepare(
          `INSERT INTO plugin_current (plugin_id, version, digest, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(plugin_id) DO UPDATE SET
             version = excluded.version,
             digest = excluded.digest,
             updated_at = excluded.updated_at`,
        )
        .run(pluginId, version, digest, now());
      this.appendJournalInternal("plugin.version.selected", pluginId, { version, digest });
    });
  }
  clearCurrentVersion(pluginId: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM plugin_current WHERE plugin_id = ?").run(pluginId);
      this.appendJournalInternal("plugin.version.cleared", pluginId, {});
    });
  }

  getPackage(pluginId: string, version: string, digest: string): PluginPackageRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT plugin_id, version, digest, publisher, source_kind, trust_level,
                root_path, manifest_json, installed_at
           FROM plugin_packages
          WHERE plugin_id = ? AND version = ? AND digest = ?`,
      )
      .get(pluginId, version, digest) as unknown as PackageRow | undefined;
    return row ? this.decodePackage(row) : undefined;
  }

  listPackages(pluginId?: string): PluginPackageRecord[] {
    const rows = (pluginId
      ? this.database
          .prepare(
            `SELECT plugin_id, version, digest, publisher, source_kind, trust_level,
                    root_path, manifest_json, installed_at
               FROM plugin_packages WHERE plugin_id = ?
              ORDER BY installed_at, version, digest`,
          )
          .all(pluginId)
      : this.database
          .prepare(
            `SELECT plugin_id, version, digest, publisher, source_kind, trust_level,
                    root_path, manifest_json, installed_at
               FROM plugin_packages ORDER BY plugin_id, installed_at, version, digest`,
          )
          .all()) as unknown as PackageRow[];
    return rows.map((row) => this.decodePackage(row));
  }

  listCurrentPackages(): PluginPackageRecord[] {
    const rows = this.database
      .prepare(
        `SELECT p.plugin_id, p.version, p.digest, p.publisher, p.source_kind, p.trust_level,
                p.root_path, p.manifest_json, p.installed_at
           FROM plugin_current AS c
           JOIN plugin_packages AS p
             ON p.plugin_id = c.plugin_id AND p.version = c.version AND p.digest = c.digest
          ORDER BY p.plugin_id`,
      )
      .all() as unknown as PackageRow[];
    return rows.map((row) => this.decodePackage(row));
  }

  removePackage(pluginId: string, version: string, digest: string): void {
    this.transaction(() => {
      const current = this.database
        .prepare(
          "SELECT 1 AS present FROM plugin_current WHERE plugin_id = ? AND version = ? AND digest = ?",
        )
        .get(pluginId, version, digest);
      if (current) throw new Error(`cannot remove current plugin version: ${pluginId}@${version}`);
      this.database
        .prepare("DELETE FROM plugin_packages WHERE plugin_id = ? AND version = ? AND digest = ?")
        .run(pluginId, version, digest);
      this.appendJournalInternal("plugin.package.removed", pluginId, { version, digest });
    });
  }

  upsertBinding(binding: PluginBinding): void {
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO plugin_bindings (
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
        )
        .run(
          binding.id,
          binding.pluginId,
          binding.entryId,
          binding.scopeType,
          binding.scopeId,
          binding.enabled ? 1 : 0,
          JSON.stringify(binding.config),
          now(),
        );
      this.appendJournalInternal(
        "plugin.binding.updated",
        binding.id,
        binding as unknown as JsonValue,
      );
    });
  }

  deleteBinding(bindingId: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM plugin_bindings WHERE id = ?").run(bindingId);
      this.appendJournalInternal("plugin.binding.deleted", bindingId, {});
    });
  }

  listBindings(pluginId?: string): PluginBinding[] {
    const rows = (pluginId
      ? this.database
          .prepare(
            `SELECT id, plugin_id, entry_id, scope_type, scope_id, enabled, config_json
               FROM plugin_bindings WHERE plugin_id = ? ORDER BY id`,
          )
          .all(pluginId)
      : this.database
          .prepare(
            `SELECT id, plugin_id, entry_id, scope_type, scope_id, enabled, config_json
               FROM plugin_bindings ORDER BY id`,
          )
          .all()) as unknown as BindingRow[];
    return rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      entryId: row.entry_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      enabled: row.enabled === 1,
      config: parseJson(row.config_json),
    }));
  }

  nextGeneration(runtimeId: string): number {
    const row = this.database
      .prepare(
        `INSERT INTO plugin_runtime_counters (runtime_id, last_generation)
         VALUES (?, 1)
         ON CONFLICT(runtime_id) DO UPDATE SET
           last_generation = plugin_runtime_counters.last_generation + 1
         RETURNING last_generation`,
      )
      .get(runtimeId) as { last_generation: number };
    return row.last_generation;
  }

  saveRuntimeGeneration(snapshot: RuntimeGenerationSnapshot): void {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO plugin_runtime_generations (
           runtime_id, plugin_id, plugin_version, entry_id, binding_id, source_kind,
           trust_level, scope_type, scope_id, generation, phase, upgrade_mode,
           host_kind, dependencies_json, error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime_id, generation) DO UPDATE SET
           phase = excluded.phase,
           dependencies_json = excluded.dependencies_json,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(
        snapshot.runtimeId,
        snapshot.pluginId,
        snapshot.pluginVersion,
        snapshot.entryId,
        snapshot.bindingId,
        snapshot.source,
        snapshot.trust,
        snapshot.scopeType,
        snapshot.scopeId,
        snapshot.generation,
        snapshot.phase,
        snapshot.upgradeMode,
        snapshot.host,
        JSON.stringify(snapshot.dependencies),
        snapshot.error ?? null,
        timestamp,
        timestamp,
      );
  }

  listRuntimeGenerations(runtimeId?: string): StoredRuntimeGeneration[] {
    const rows = (runtimeId
      ? this.database
          .prepare(
            `SELECT runtime_id, plugin_id, plugin_version, entry_id, binding_id, source_kind,
                    trust_level, scope_type, scope_id, generation, phase, upgrade_mode,
                    host_kind, dependencies_json, error, created_at, updated_at
               FROM plugin_runtime_generations
              WHERE runtime_id = ?
              ORDER BY generation`,
          )
          .all(runtimeId)
      : this.database
          .prepare(
            `SELECT runtime_id, plugin_id, plugin_version, entry_id, binding_id, source_kind,
                    trust_level, scope_type, scope_id, generation, phase, upgrade_mode,
                    host_kind, dependencies_json, error, created_at, updated_at
               FROM plugin_runtime_generations
              ORDER BY runtime_id, generation`,
          )
          .all()) as unknown as GenerationRow[];
    return rows.map((row) => ({
      runtimeId: row.runtime_id,
      pluginId: row.plugin_id,
      pluginVersion: row.plugin_version,
      entryId: row.entry_id,
      bindingId: row.binding_id,
      source: row.source_kind,
      trust: row.trust_level,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      generation: row.generation,
      phase: row.phase,
      upgradeMode: row.upgrade_mode,
      host: row.host_kind,
      dependencies: parseJson(row.dependencies_json) as string[],
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  saveRuntimePublication(snapshot: RuntimePublicationSnapshot): void {
    this.database
      .prepare(
        `INSERT INTO plugin_runtime_publications (runtime_id, generation, epoch, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(runtime_id) DO UPDATE SET
           generation = excluded.generation,
           epoch = excluded.epoch,
           updated_at = excluded.updated_at`,
      )
      .run(snapshot.runtimeId, snapshot.generation, snapshot.epoch, now());
  }

  listRuntimePublications(): StoredRuntimePublication[] {
    const rows = this.database
      .prepare(
        `SELECT runtime_id, generation, epoch, updated_at
           FROM plugin_runtime_publications
          ORDER BY runtime_id`,
      )
      .all() as unknown as PublicationRow[];
    return rows.map((row) => ({
      runtimeId: row.runtime_id,
      generation: row.generation,
      epoch: row.epoch,
      updatedAt: row.updated_at,
    }));
  }

  saveRuntimeOperation(snapshot: RuntimeOperationSnapshot): void {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO plugin_runtime_operations (
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
      )
      .run(
        snapshot.id,
        snapshot.runtimeId,
        snapshot.kind,
        snapshot.mode,
        snapshot.status,
        snapshot.step,
        snapshot.currentGeneration,
        snapshot.candidateGeneration,
        snapshot.attentionRequired ? 1 : 0,
        snapshot.error ?? null,
        timestamp,
        timestamp,
      );
  }

  listRuntimeOperations(runtimeId?: string): StoredRuntimeOperation[] {
    const rows = (runtimeId
      ? this.database
          .prepare(
            `SELECT id, runtime_id, kind, mode, status, step, current_generation,
                    candidate_generation, attention_required, error, started_at, updated_at
               FROM plugin_runtime_operations
              WHERE runtime_id = ?
              ORDER BY started_at, id`,
          )
          .all(runtimeId)
      : this.database
          .prepare(
            `SELECT id, runtime_id, kind, mode, status, step, current_generation,
                    candidate_generation, attention_required, error, started_at, updated_at
               FROM plugin_runtime_operations
              ORDER BY started_at, id`,
          )
          .all()) as unknown as OperationRow[];
    return rows.map((row) => ({
      id: row.id,
      runtimeId: row.runtime_id,
      kind: row.kind,
      mode: row.mode,
      status: row.status,
      step: row.step,
      currentGeneration: row.current_generation,
      candidateGeneration: row.candidate_generation,
      attentionRequired: row.attention_required === 1,
      ...(row.error ? { error: row.error } : {}),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));
  }

  invalidateRuntimePublications(): void {
    this.database
      .prepare(
        `UPDATE plugin_runtime_publications
            SET generation = NULL,
                epoch = epoch + 1,
                updated_at = ?
          WHERE generation IS NOT NULL`,
      )
      .run(now());
  }

  interruptRuntimeOperations(): void {
    this.database
      .prepare(
        `UPDATE plugin_runtime_operations
            SET status = 'interrupted',
                error = COALESCE(error, 'SeaShard stopped before the operation completed'),
                updated_at = ?
          WHERE status = 'running'`,
      )
      .run(now());
  }

  appendJournal(category: string, aggregateId: string, payload: JsonValue): number {
    return this.appendJournalInternal(category, aggregateId, payload);
  }

  listJournal(afterId = 0): JournalRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, occurred_at, category, aggregate_id, payload_json
           FROM operation_journal WHERE id > ? ORDER BY id`,
      )
      .all(afterId) as unknown as JournalRow[];
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      category: row.category,
      aggregateId: row.aggregate_id,
      payload: parseJson(row.payload_json),
    }));
  }

  private appendJournalInternal(category: string, aggregateId: string, payload: JsonValue): number {
    const result = this.database
      .prepare(
        `INSERT INTO operation_journal (occurred_at, category, aggregate_id, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(now(), category, aggregateId, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  private decodePackage(row: PackageRow): PluginPackageRecord {
    return {
      manifest: parsePluginManifest(JSON.parse(row.manifest_json), this.seaShardVersion),
      digest: row.digest,
      rootPath: row.root_path,
      source: row.source_kind,
      trust: row.trust_level,
      installedAt: row.installed_at,
    };
  }

  private transaction<T>(execute: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = execute();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    if (row.version > 2) throw new Error(`database schema ${row.version} is newer than this build`);

    if (row.version < 1) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE plugin_packages (
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
          ) STRICT;

          CREATE TABLE plugin_current (
            plugin_id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            digest TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (plugin_id, version, digest)
              REFERENCES plugin_packages(plugin_id, version, digest) ON DELETE RESTRICT
          ) STRICT;

          CREATE TABLE plugin_trust (
            plugin_id TEXT NOT NULL,
            version TEXT NOT NULL,
            digest TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_root TEXT NOT NULL,
            trust_level TEXT NOT NULL,
            granted_at TEXT NOT NULL,
            PRIMARY KEY (plugin_id, version, digest)
          ) STRICT;

          CREATE TABLE plugin_bindings (
            id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            config_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE plugin_runtime_units (
            runtime_id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            plugin_version TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            binding_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            trust_level TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            desired_state TEXT NOT NULL,
            actual_state TEXT NOT NULL,
            reload_policy TEXT NOT NULL,
            host_kind TEXT NOT NULL,
            dependencies_json TEXT NOT NULL,
            error TEXT,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE operation_journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            category TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            payload_json TEXT NOT NULL
          ) STRICT;

          CREATE INDEX plugin_bindings_plugin_idx ON plugin_bindings(plugin_id);
          CREATE INDEX runtime_units_binding_idx ON plugin_runtime_units(binding_id);
          CREATE INDEX journal_aggregate_idx ON operation_journal(aggregate_id, id);
        `);
        this.database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
          .run(now());
      });
    }

    if (row.version < 2) {
      this.transaction(() => {
        const manifests = this.database
          .prepare("SELECT plugin_id, version, digest, manifest_json FROM plugin_packages")
          .all() as unknown as StoredManifestRow[];
        const updateManifest = this.database.prepare(
          `UPDATE plugin_packages
              SET manifest_json = ?
            WHERE plugin_id = ? AND version = ? AND digest = ?`,
        );
        for (const manifest of manifests) {
          updateManifest.run(
            migrateStoredManifest(manifest.manifest_json),
            manifest.plugin_id,
            manifest.version,
            manifest.digest,
          );
        }

        this.database.exec(`
          CREATE TABLE plugin_runtime_counters (
            runtime_id TEXT PRIMARY KEY,
            last_generation INTEGER NOT NULL
          ) STRICT;

          INSERT INTO plugin_runtime_counters (runtime_id, last_generation)
          SELECT runtime_id, MAX(generation)
            FROM plugin_runtime_units
           GROUP BY runtime_id;

          DROP TABLE plugin_runtime_units;

          CREATE TABLE plugin_runtime_generations (
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
          ) STRICT;

          CREATE TABLE plugin_runtime_publications (
            runtime_id TEXT PRIMARY KEY,
            generation INTEGER,
            epoch INTEGER NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE plugin_runtime_operations (
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
          ) STRICT;

          CREATE INDEX runtime_generations_binding_idx
            ON plugin_runtime_generations(binding_id, generation);
          CREATE INDEX runtime_operations_runtime_idx
            ON plugin_runtime_operations(runtime_id, started_at);
        `);
        this.database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)")
          .run(now());
      });
    }
  }
}

function migrateStoredManifest(value: string): string {
  const manifest = JSON.parse(value) as {
    entries?: Array<Record<string, unknown>>;
  };
  for (const entry of manifest.entries ?? []) {
    if (entry.upgradeMode !== undefined || typeof entry.reloadPolicy !== "string") continue;
    entry.upgradeMode = entry.reloadPolicy === "hot" ? "hot-swap" : "stop-first";
    delete entry.reloadPolicy;
  }
  return JSON.stringify(manifest);
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function now(): string {
  return new Date().toISOString();
}
