import type {
  JsonValue,
  PluginBinding,
  PluginEntryManifest,
  PluginManifest,
  PluginSourceKind,
  PluginTrustLevel,
  RuntimeGenerationSnapshot,
  RuntimeOperationSnapshot,
  RuntimePublicationSnapshot,
} from "@seashard/plugin-sdk";

export interface PluginPackageRecord {
  manifest: PluginManifest;
  digest: string;
  rootPath: string;
  source: PluginSourceKind;
  trust: PluginTrustLevel;
  installedAt: string;
}

export interface TrustGrant {
  digest: string;
  acknowledgeFullMachineAccess: true;
}

export interface InstallCandidate {
  manifest: PluginManifest;
  digest: string;
  sourceRoot: string;
  files: readonly PackageFile[];
}

export interface PackageFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

export interface ResolvedEntry {
  package: PluginPackageRecord;
  entry: PluginEntryManifest;
  binding: PluginBinding;
  runtimeId: string;
  host: "core" | "node-plugin-host" | "client";
}

export interface StoredRuntimeGeneration extends RuntimeGenerationSnapshot {
  createdAt: string;
  updatedAt: string;
}

export interface StoredRuntimePublication extends RuntimePublicationSnapshot {
  updatedAt: string;
}

export interface StoredRuntimeOperation extends RuntimeOperationSnapshot {
  startedAt: string;
  updatedAt: string;
}

export interface JournalRecord {
  id: number;
  occurredAt: string;
  category: string;
  aggregateId: string;
  payload: JsonValue;
}

export interface BuiltInModuleLoader {
  load(): Promise<unknown>;
}

export interface BuiltInPackageRegistration {
  manifest: PluginManifest;
  loaders: Readonly<Record<string, BuiltInModuleLoader>>;
  bindings: readonly Omit<PluginBinding, "pluginId">[];
}
