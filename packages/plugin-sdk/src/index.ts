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

/** Agent 资源展示字段只供 Tool Call 卡片使用，永不进入模型上下文。 */
export interface AgentActivityPresentationField {
  readonly label?: string;
  readonly value: string;
  readonly unit?: string;
}
/** Renderer 只接受 Host 内建的语义图标，禁止插件注入组件名、URL 或任意 SVG。 */
export const agentActivityPresentationIcons = ["wrench", "help"] as const;
export type AgentActivityPresentationIcon = (typeof agentActivityPresentationIcons)[number];

export function isAgentActivityPresentationIcon(
  value: unknown,
): value is AgentActivityPresentationIcon {
  return value === "wrench" || value === "help";
}

export const defaultAgentResourcePresentationTitle = "读取资源";

export interface AgentResourcePresentationDefinition {
  readonly title: string;
  readonly icon?: AgentActivityPresentationIcon;
}

/** 资源对象中的可序列化能力说明；挂载 Pattern 由 agentResources() 的键提供。 */
export interface AgentResourceDescriptor {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputDescription?: string;
  readonly examples?: readonly JsonValue[];
  readonly help?: string;
  readonly presentation?: AgentResourcePresentationDefinition;
}

/** Registry 与 External Plugin Host 使用的完整可序列化路由定义。 */
export interface AgentResourceDefinition extends AgentResourceDescriptor {
  readonly pattern: string;
}

export interface AgentResourceUri {
  readonly href: string;
  readonly scheme: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface AgentResourceReadRequest<Input extends JsonValue = JsonValue> {
  readonly uri: AgentResourceUri;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly input: Input;
}

export interface AgentResourceReadResult<Output extends JsonValue = JsonValue> {
  readonly mimeType: string;
  readonly content: Output;
}

export interface AgentResourceExecutionContext {
  readonly signal?: AbortSignal;
}

export interface AgentResourceImplementation<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
> {
  read(
    request: AgentResourceReadRequest<Input>,
    context: AgentResourceExecutionContext,
  ): Awaitable<AgentResourceReadResult<Output>>;
  presentRequest?(
    request: AgentResourceReadRequest<Input>,
  ): Awaitable<readonly AgentActivityPresentationField[]>;
  presentResult?(
    request: AgentResourceReadRequest<Input>,
    result: AgentResourceReadResult<Output>,
  ): Awaitable<readonly AgentActivityPresentationField[]>;
}

export interface AgentResource<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
> extends AgentResourceDescriptor {
  readonly implementation: AgentResourceImplementation<Input, Output>;
}

export type AgentResourceMap = Readonly<Record<string, AgentResource>>;

/** 保留资源输入与输出的泛型推导；注册行为仍由 PluginContext 提供。 */
export function defineAgentResource<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
>(resource: AgentResource<Input, Output>): AgentResource<Input, Output> {
  return resource;
}

export interface PluginContext {
  readonly execution: ExecutionContext;
  readonly runtimeId: string;
  readonly storage: PluginStorage;
  effect(execute: () => Awaitable<Disposable | void>, label?: string): void;
  provide(contract: string, provider: ServiceProvider): void;
  service<T extends object>(contract: string): T;
  contribute(kind: string, value: JsonValue): string;
  agentTool(definition: AgentToolDefinition, execute: AgentToolHandler): string;
  agentResources(resources: AgentResourceMap): void;
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
