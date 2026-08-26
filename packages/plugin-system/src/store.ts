import type {
  DataCommandRequest,
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
} from "@seashard/plugin-sdk";
import { pluginSystemDataCapsule } from "./data-capsule";
import { parseInternalPluginManifest } from "./manifest";
import type { PluginPackageRecord } from "./types";

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
    await this.run("package.upsert", [
      record.manifest.id,
      record.manifest.version,
      record.digest,
      record.manifest.publisher,
      record.source,
      record.trust,
      record.rootPath,
      JSON.stringify(record.manifest),
      record.installedAt,
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
    await this.run("package.current.set", [pluginId, version, digest, now()]);
  }

  async clearCurrentVersion(pluginId: string): Promise<void> {
    await this.run("package.current.clear", [pluginId]);
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
    const requests: DataCommandRequest[] = [
      { command: "trust.delete", parameters: [pluginId, version, digest] },
      { command: "package.delete", parameters: [pluginId, version, digest] },
    ];
    const results = await this.repository.transaction(requests);
    if (results.length !== requests.length) {
      throw new Error(
        `database transaction returned ${results.length} results for ${requests.length} commands`,
      );
    }
    for (const [index, result] of results.entries()) {
      if (result.kind !== "run") throw unexpectedResult(requests[index]!.command, result);
    }
  }
  /**
   * 在一个写事务内替换当前包选择及其自动 Binding 集合。
   *
   * 事务先确认目标包可被选中，再删除同插件的旧自动 Binding，最后完整插入新集合。
   * 任意一步失败时，SQLite 会恢复选择和 Binding，下一次启动不会观察到半套状态。
   */
  async replaceCurrentPackageBindings(
    pluginId: string,
    current: PluginPackageRecord | undefined,
    bindingPrefix: string,
    bindings: readonly PluginBinding[],
  ): Promise<void> {
    if (current && current.manifest.id !== pluginId) {
      throw new Error(
        `plugin package selection mismatch: expected ${pluginId}, received ${current.manifest.id}`,
      );
    }
    if (bindings.some((binding) => binding.pluginId !== pluginId)) {
      throw new Error(`plugin binding replacement crosses package boundary: ${pluginId}`);
    }

    const timestamp = now();
    const requests: DataCommandRequest[] = [
      current
        ? {
            command: "package.current.set",
            parameters: [pluginId, current.manifest.version, current.digest, timestamp],
          }
        : {
            command: "package.current.clear",
            parameters: [pluginId],
          },
      {
        command: "binding.delete-by-plugin-prefix",
        parameters: [pluginId, bindingPrefix],
      },
      ...bindings.map((binding): DataCommandRequest => ({
        command: "binding.insert",
        parameters: [
          binding.id,
          binding.pluginId,
          binding.entryId,
          binding.scopeType,
          binding.scopeId,
          binding.enabled ? 1 : 0,
          JSON.stringify(binding.config),
          timestamp,
        ],
      })),
    ];
    const results = await this.repository.transaction(requests);
    if (results.length !== requests.length) {
      throw new Error(
        `database transaction returned ${results.length} results for ${requests.length} commands`,
      );
    }
    for (const [index, result] of results.entries()) {
      if (result.kind !== "run") throw unexpectedResult(requests[index]!.command, result);
    }
  }

  async upsertBinding(binding: PluginBinding): Promise<void> {
    await this.run("binding.upsert", [
      binding.id,
      binding.pluginId,
      binding.entryId,
      binding.scopeType,
      binding.scopeId,
      binding.enabled ? 1 : 0,
      JSON.stringify(binding.config),
      now(),
    ]);
  }

  async deleteBinding(bindingId: string): Promise<void> {
    await this.run("binding.delete", [bindingId]);
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
      manifest: parseInternalPluginManifest(JSON.parse(row.manifest_json), this.seaShardVersion),
      digest: row.digest,
      rootPath: row.root_path,
      source: row.source_kind,
      trust: row.trust_level,
      installedAt: row.installed_at,
    };
  }
}

function unexpectedResult(command: string, result: DatabaseCommandResult): Error {
  return new Error(`database command ${command} returned ${result.kind}`);
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function now(): string {
  return new Date().toISOString();
}
