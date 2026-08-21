import type {
  PluginBinding,
  PluginEntryManifest,
  PluginManifest,
  PluginSourceKind,
  PluginTrustLevel,
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

export interface ResolvedClientEntrySnapshot {
  revision: number;
  entries: readonly ResolvedEntry[];
}

export interface BuiltInModuleLoader {
  load(): Promise<unknown>;
}

export interface BuiltInPackageRegistration {
  manifest: PluginManifest;
  loaders: Readonly<Record<string, BuiltInModuleLoader>>;
  bindings: readonly Omit<PluginBinding, "pluginId">[];
}
