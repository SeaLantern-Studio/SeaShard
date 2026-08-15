export type Awaitable<T> = T | Promise<T>;
export type Disposable = () => Awaitable<void>;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type HostProfile = "electron" | "node" | "docker";
export type ClientTarget = "desktop" | "web" | "mobile";
export type PluginRuntime = "host" | "client";
export type ActivationScope = "global" | "workspace" | "server" | "agent" | "client-session";
export type UpgradeMode = "hot-swap" | "stop-first";
export type PluginSourceKind = "builtin" | "development" | "installed";
export type PluginTrustLevel = "builtin" | "official" | "local-full-trust" | "package-full-trust";
export type OperatingSystem =
  | "win32"
  | "darwin"
  | "linux"
  | "aix"
  | "freebsd"
  | "openbsd"
  | "sunos";
export type CpuArchitecture = "x64" | "arm64" | "ia32" | "arm" | "riscv64" | "ppc64" | "s390x";

export type RuntimeGenerationPhase = "prepared" | "running" | "failed" | "terminated";
export type RuntimeOperationKind = "activate" | "replace" | "reload" | "deactivate";
export type RuntimeOperationStatus = "running" | "completed" | "failed" | "interrupted";
export type RuntimeOperationStep =
  | "prepare"
  | "wait-dependencies"
  | "start-candidate"
  | "publish"
  | "drain-previous"
  | "stop-previous"
  | "rollback";

export interface PluginCompatibility {
  seaShard: string;
  clientProtocol?: string;
}

export interface PluginEntryManifest {
  id: string;
  runtime: PluginRuntime;
  module: string;
  hostProfiles?: HostProfile[];
  targets?: ClientTarget[];
  activationScopes: ActivationScope[];
  permissions: string[];
  upgradeMode: UpgradeMode;
  os?: OperatingSystem[];
  arch?: CpuArchitecture[];
}

export interface PluginManifest {
  id: string;
  version: string;
  publisher: string;
  atomic?: boolean;
  entries: PluginEntryManifest[];
  compatibility: PluginCompatibility;
}

export interface PluginBinding {
  id: string;
  pluginId: string;
  entryId: string;
  scopeType: ActivationScope;
  scopeId: string;
  enabled: boolean;
  config: JsonValue;
}

export interface ScopeAddress {
  type: ActivationScope;
  id: string;
}

export interface ExecutionContext {
  actorType: "core" | "plugin" | "client" | "agent" | "task";
  actorId: string;
  runtimeId?: string;
  generation?: number;
  scopeType: ActivationScope;
  scopeId: string;
  permissionRevision: number;
  scopeChain: readonly ScopeAddress[];
  permissions: readonly string[];
}

export type ServiceMethod = (...args: JsonValue[]) => Awaitable<JsonValue | void>;
export type ServiceProvider = Record<string, ServiceMethod>;

export interface PluginContext {
  readonly execution: ExecutionContext;
  readonly runtimeId: string;
  readonly generation: number;
  effect(execute: () => Awaitable<Disposable | void>, label?: string): void;
  provide(contract: string, provider: ServiceProvider): void;
  service<T extends object>(contract: string): T;
  contribute(kind: string, value: JsonValue): string;
  on(event: string, handler: (payload: JsonValue) => Awaitable<void>): void;
  emit(event: string, payload: JsonValue): Promise<void>;
}

interface StandardSchemaResult {
  value?: unknown;
  issues?: readonly { message: string; path?: readonly PropertyKey[] }[];
}

export interface StandardSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): Awaitable<StandardSchemaResult>;
  };
}

export interface PluginModule {
  inject?: readonly string[];
  provides?: readonly string[];
  Config?: StandardSchema;
  apply(ctx: PluginContext, config: JsonValue): Awaitable<Disposable | void>;
}

export interface RuntimeGenerationSnapshot {
  runtimeId: string;
  pluginId: string;
  pluginVersion: string;
  entryId: string;
  bindingId: string;
  source: PluginSourceKind;
  trust: PluginTrustLevel;
  scopeType: ActivationScope;
  scopeId: string;
  generation: number;
  phase: RuntimeGenerationPhase;
  upgradeMode: UpgradeMode;
  host: "core" | "node-plugin-host" | "client";
  dependencies: readonly string[];
  error?: string;
}

export interface RuntimePublicationSnapshot {
  runtimeId: string;
  generation: number | null;
  epoch: number;
}

export interface RuntimeOperationSnapshot {
  id: string;
  runtimeId: string;
  kind: RuntimeOperationKind;
  mode: UpgradeMode;
  status: RuntimeOperationStatus;
  step: RuntimeOperationStep;
  currentGeneration: number | null;
  candidateGeneration: number | null;
  attentionRequired: boolean;
  error?: string;
}

export interface RuntimeControlSnapshot {
  generations: readonly RuntimeGenerationSnapshot[];
  publications: readonly RuntimePublicationSnapshot[];
  operations: readonly RuntimeOperationSnapshot[];
}
