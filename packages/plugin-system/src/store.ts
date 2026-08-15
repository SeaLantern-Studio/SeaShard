import type {
  DatabaseCommandResult,
  DatabaseRow,
  DatabaseService,
  DatabaseValue,
  RegisteredDataCapsule,
} from "@seashard/database";
import type {
  JsonValue,
  PluginBinding,
  PluginSourceKind,
  PluginTrustLevel,
  RuntimeGenerationSnapshot,
  RuntimeOperationSnapshot,
  RuntimePublicationSnapshot,
} from "@seashard/plugin-sdk";
import { pluginSystemDataCapsule } from "./data-capsule";
import { parsePluginManifest } from "./manifest";
import type {
  JournalRecord,
  PluginPackageRecord,
  StoredRuntimeGeneration,
  StoredRuntimeOperation,
  StoredRuntimePublication,
} from "./types";

interface PackageRow extends DatabaseRow {
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

interface BindingRow extends DatabaseRow {
  id: string;
  plugin_id: string;
  entry_id: string;
  scope_type: PluginBinding["scopeType"];
  scope_id: string;
  enabled: number;
  config_json: string;
}

interface GenerationRow extends DatabaseRow {
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

interface PublicationRow extends DatabaseRow {
  runtime_id: string;
  generation: number | null;
  epoch: number;
  updated_at: string;
}

interface OperationRow extends DatabaseRow {
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

interface JournalRow extends DatabaseRow {
  id: number;
  occurred_at: string;
  category: string;
  aggregate_id: string;
  payload_json: string;
}

export class PluginStore {
  private constructor(
    private readonly repository: RegisteredDataCapsule,
    private readonly seaShardVersion: string,
  ) {}

  static async create(database: DatabaseService, seaShardVersion: string): Promise<PluginStore> {
    const repository = await database.registerCapsule(pluginSystemDataCapsule);
    return new PluginStore(repository, seaShardVersion);
  }

  async registerPackage(record: PluginPackageRecord): Promise<void> {
    await this.repository.transaction([
      {
        command: "package.upsert",
        parameters: [
          record.manifest.id,
          record.manifest.version,
          record.digest,
          record.manifest.publisher,
          record.source,
          record.trust,
          record.rootPath,
          JSON.stringify(record.manifest),
          record.installedAt,
        ],
      },
      journalCommand("plugin.package.registered", record.manifest.id, {
        version: record.manifest.version,
        digest: record.digest,
        source: record.source,
        trust: record.trust,
      }),
    ]);
  }

  async grantTrust(record: PluginPackageRecord): Promise<void> {
    await this.run("trust.upsert", [
      record.manifest.id,
      record.manifest.version,
      record.digest,
      record.source,
      record.rootPath,
      record.trust,
      record.installedAt,
    ]);
  }

  async setCurrentVersion(pluginId: string, version: string, digest: string): Promise<void> {
    const record = await this.getPackage(pluginId, version, digest);
    if (!record) throw new Error(`plugin package not installed: ${pluginId}@${version}#${digest}`);
    await this.repository.transaction([
      {
        command: "package.current.set",
        parameters: [pluginId, version, digest, now()],
      },
      journalCommand("plugin.version.selected", pluginId, { version, digest }),
    ]);
  }

  async clearCurrentVersion(pluginId: string): Promise<void> {
    await this.repository.transaction([
      { command: "package.current.clear", parameters: [pluginId] },
      journalCommand("plugin.version.cleared", pluginId, {}),
    ]);
  }

  async getPackage(
    pluginId: string,
    version: string,
    digest: string,
  ): Promise<PluginPackageRecord | undefined> {
    const row = (await this.get("package.get", [pluginId, version, digest])) as
      | PackageRow
      | undefined;
    return row ? this.decodePackage(row) : undefined;
  }

  async listPackages(pluginId?: string): Promise<PluginPackageRecord[]> {
    const rows = (await this.all(
      pluginId ? "package.list-by-plugin" : "package.list",
      pluginId ? [pluginId] : [],
    )) as PackageRow[];
    return rows.map((row) => this.decodePackage(row));
  }

  async listCurrentPackages(): Promise<PluginPackageRecord[]> {
    const rows = (await this.all("package.list-current")) as PackageRow[];
    return rows.map((row) => this.decodePackage(row));
  }

  async removePackage(pluginId: string, version: string, digest: string): Promise<void> {
    const current = await this.get("package.current-is", [pluginId, version, digest]);
    if (current) throw new Error(`cannot remove current plugin version: ${pluginId}@${version}`);
    await this.repository.transaction([
      { command: "package.delete", parameters: [pluginId, version, digest] },
      journalCommand("plugin.package.removed", pluginId, { version, digest }),
    ]);
  }

  async upsertBinding(binding: PluginBinding): Promise<void> {
    await this.repository.transaction([
      {
        command: "binding.upsert",
        parameters: [
          binding.id,
          binding.pluginId,
          binding.entryId,
          binding.scopeType,
          binding.scopeId,
          binding.enabled ? 1 : 0,
          JSON.stringify(binding.config),
          now(),
        ],
      },
      journalCommand("plugin.binding.updated", binding.id, binding as unknown as JsonValue),
    ]);
  }

  async deleteBinding(bindingId: string): Promise<void> {
    await this.repository.transaction([
      { command: "binding.delete", parameters: [bindingId] },
      journalCommand("plugin.binding.deleted", bindingId, {}),
    ]);
  }

  async listBindings(pluginId?: string): Promise<PluginBinding[]> {
    const rows = (await this.all(
      pluginId ? "binding.list-by-plugin" : "binding.list",
      pluginId ? [pluginId] : [],
    )) as BindingRow[];
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

  async nextGeneration(runtimeId: string): Promise<number> {
    const row = await this.get("generation.next", [runtimeId]);
    if (!row) throw new Error(`generation counter returned no value: ${runtimeId}`);
    return toNumber(row.last_generation, "last_generation");
  }

  async saveRuntimeGeneration(snapshot: RuntimeGenerationSnapshot): Promise<void> {
    const timestamp = now();
    await this.run("generation.save", [
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
    ]);
  }

  async listRuntimeGenerations(runtimeId?: string): Promise<StoredRuntimeGeneration[]> {
    const rows = (await this.all(
      runtimeId ? "generation.list-by-runtime" : "generation.list",
      runtimeId ? [runtimeId] : [],
    )) as GenerationRow[];
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

  async saveRuntimePublication(snapshot: RuntimePublicationSnapshot): Promise<void> {
    await this.run("publication.save", [
      snapshot.runtimeId,
      snapshot.generation,
      snapshot.epoch,
      now(),
    ]);
  }

  async listRuntimePublications(): Promise<StoredRuntimePublication[]> {
    const rows = (await this.all("publication.list")) as PublicationRow[];
    return rows.map((row) => ({
      runtimeId: row.runtime_id,
      generation: row.generation,
      epoch: row.epoch,
      updatedAt: row.updated_at,
    }));
  }

  async saveRuntimeOperation(snapshot: RuntimeOperationSnapshot): Promise<void> {
    const timestamp = now();
    await this.run("operation.save", [
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
    ]);
  }

  async listRuntimeOperations(runtimeId?: string): Promise<StoredRuntimeOperation[]> {
    const rows = (await this.all(
      runtimeId ? "operation.list-by-runtime" : "operation.list",
      runtimeId ? [runtimeId] : [],
    )) as OperationRow[];
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

  async invalidateRuntimePublications(): Promise<void> {
    await this.run("publication.invalidate", [now()]);
  }

  async interruptRuntimeOperations(): Promise<void> {
    await this.run("operation.interrupt", [now()]);
  }

  async appendJournal(category: string, aggregateId: string, payload: JsonValue): Promise<number> {
    const result = await this.run("journal.append", [
      now(),
      category,
      aggregateId,
      JSON.stringify(payload),
    ]);
    return toNumber(result.lastInsertRowid, "lastInsertRowid");
  }

  async listJournal(afterId = 0): Promise<JournalRecord[]> {
    const rows = (await this.all("journal.list", [afterId])) as JournalRow[];
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      category: row.category,
      aggregateId: row.aggregate_id,
      payload: parseJson(row.payload_json),
    }));
  }

  private async run(command: string, parameters: readonly DatabaseValue[] = []) {
    const result = await this.repository.execute(command, parameters);
    if (result.kind !== "run") throw unexpectedResult(command, result);
    return result;
  }

  private async get(
    command: string,
    parameters: readonly DatabaseValue[] = [],
  ): Promise<DatabaseRow | undefined> {
    const result = await this.repository.execute(command, parameters);
    if (result.kind !== "get") throw unexpectedResult(command, result);
    return result.row ?? undefined;
  }

  private async all(
    command: string,
    parameters: readonly DatabaseValue[] = [],
  ): Promise<DatabaseRow[]> {
    const result = await this.repository.execute(command, parameters);
    if (result.kind !== "all") throw unexpectedResult(command, result);
    return result.rows;
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
}

function journalCommand(category: string, aggregateId: string, payload: JsonValue) {
  return {
    command: "journal.append",
    parameters: [now(), category, aggregateId, JSON.stringify(payload)] as DatabaseValue[],
  };
}

function unexpectedResult(command: string, result: DatabaseCommandResult): Error {
  return new Error(`database command ${command} returned ${result.kind}`);
}

function toNumber(value: DatabaseValue | undefined, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`database field ${field} is not an integer`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError(`database field ${field} is out of range`);
  return result;
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function now(): string {
  return new Date().toISOString();
}
