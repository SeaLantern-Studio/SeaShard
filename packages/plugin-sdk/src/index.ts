export type Awaitable<T> = T | Promise<T>;
export type Disposable = () => Awaitable<void>;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type HostProfile = "electron" | "node" | "docker";
export type ClientTarget = "desktop" | "web" | "mobile";
export type PluginRuntime = "host" | "client";
export type ActivationScope = "global" | "workspace" | "server" | "agent" | "client-session";
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

export type RuntimePluginState = "active" | "failed";

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
  scopeType: ActivationScope;
  scopeId: string;
  permissionRevision: number;
  scopeChain: readonly ScopeAddress[];
  permissions: readonly string[];
}

export type ServiceMethod = (...args: JsonValue[]) => Awaitable<JsonValue | void>;
export type ServiceProvider = Record<string, ServiceMethod>;
export interface PluginStoredDocument {
  readonly value: JsonValue;
  readonly revision: number;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export interface PluginStoragePutOptions {
  readonly expectedRevision?: number | null;
  readonly ttlMs?: number;
}

export interface PluginStorageDeleteOptions {
  readonly expectedRevision?: number;
}

export interface PluginStorage {
  get(key: string): Promise<PluginStoredDocument | undefined>;
  put(
    key: string,
    value: JsonValue,
    options?: PluginStoragePutOptions,
  ): Promise<PluginStoredDocument>;
  delete(key: string, options?: PluginStorageDeleteOptions): Promise<boolean>;
}

export interface PluginStorageBroker {
  for(execution: ExecutionContext): PluginStorage;
}

/**
 * Agent 工具声明只描述能力语义；运行时身份与生命周期由 Plugin Kernel 补齐。
 */
export interface AgentToolDefinition {
  readonly namespace: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputDescription?: string;
  readonly examples?: JsonValue[];
}

export interface AgentToolExecutionContext {
  readonly signal?: AbortSignal;
}

export type AgentToolHandler = (
  input: JsonValue,
  context: AgentToolExecutionContext,
) => Awaitable<JsonValue>;

export interface PluginContext {
  readonly execution: ExecutionContext;
  readonly runtimeId: string;
  readonly storage: PluginStorage;
  effect(execute: () => Awaitable<Disposable | void>, label?: string): void;
  provide(contract: string, provider: ServiceProvider): void;
  service<T extends object>(contract: string): T;
  contribute(kind: string, value: JsonValue): string;
  agentTool(definition: AgentToolDefinition, execute: AgentToolHandler): string;
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

export interface RuntimePluginSnapshot {
  runtimeId: string;
  pluginId: string;
  pluginVersion: string;
  entryId: string;
  host: "core" | "node-plugin-host" | "client";
  state: RuntimePluginState;
  error?: string;
}

export interface RuntimeControlSnapshot {
  plugins: readonly RuntimePluginSnapshot[];
}
