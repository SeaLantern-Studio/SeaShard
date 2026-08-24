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

export interface ServiceResultValidationIssue {
  readonly path?: readonly PropertyKey[];
  readonly message: string;
}

/**
 * 返回值校验器只判断 Provider 是否兑现 Contract，不参与结果投影或修正。
 */
export interface ServiceResultValidator {
  validate(value: unknown): Awaitable<readonly ServiceResultValidationIssue[]>;
}

export interface ServiceProvideOptions {
  readonly resultValidators?: Readonly<Record<string, ServiceResultValidator>>;
}

const emptyServiceResultValidators = Object.freeze(
  Object.create(null) as Record<string, ServiceResultValidator>,
);

/**
 * 注册时冻结方法到校验器的映射，避免 Provider 后续修改 options 影响已发布能力。
 */
export function resolveServiceResultValidators(
  contract: string,
  provider: ServiceProvider,
  options?: ServiceProvideOptions,
): Readonly<Record<string, ServiceResultValidator>> {
  if (!options?.resultValidators) return emptyServiceResultValidators;
  const resolved = Object.create(null) as Record<string, ServiceResultValidator>;
  for (const [method, validator] of Object.entries(options.resultValidators)) {
    if (!Object.hasOwn(provider, method) || typeof provider[method] !== "function") {
      throw new TypeError(
        `service result validator targets a missing method: ${contract}.${method}`,
      );
    }
    if (!validator || typeof validator.validate !== "function") {
      throw new TypeError(`service result validator is invalid: ${contract}.${method}`);
    }
    resolved[method] = validator;
  }
  return Object.freeze(resolved);
}

/** Service 只允许调用 Provider 自己发布的方法，不能穿透到 Object.prototype。 */
export function getServiceProviderMethod(
  provider: ServiceProvider,
  method: string,
): ServiceMethod | undefined {
  if (!Object.hasOwn(provider, method)) return undefined;
  const candidate = provider[method];
  return typeof candidate === "function" ? candidate : undefined;
}
/**
 * Runtime 在对应 Provider 的调用边界抛出该错误，字段用于准确归责组件与方法。
 */
export class ServiceResultValidationError extends Error {
  readonly runtimeId: string;
  readonly contract: string;
  readonly method: string;
  readonly issues: readonly ServiceResultValidationIssue[];

  constructor(
    runtimeId: string,
    contract: string,
    method: string,
    issues: readonly ServiceResultValidationIssue[],
  ) {
    const details = issues
      .map((issue) => {
        const path = issue.path?.length ? ` at ${issue.path.map(String).join(".")}` : "";
        return `${issue.message}${path}`;
      })
      .join("; ");
    super(
      `service result validation failed for ${contract}.${method} from ${runtimeId}: ${details}`,
    );
    this.name = "ServiceResultValidationError";
    this.runtimeId = runtimeId;
    this.contract = contract;
    this.method = method;
    this.issues = issues;
  }
}

/** 共享给本地 Runtime 与 Plugin Host，保证校验位置不同但失败语义一致。 */
export async function validateServiceResult(
  validator: ServiceResultValidator | undefined,
  value: unknown,
  identity: {
    readonly runtimeId: string;
    readonly contract: string;
    readonly method: string;
  },
): Promise<void> {
  if (!validator) return;
  const issues = await validator.validate(value);
  if (!Array.isArray(issues)) {
    throw new TypeError(
      `service result validator for ${identity.contract}.${identity.method} must return an issue array`,
    );
  }
  for (const issue of issues) {
    const path = issue && typeof issue === "object" ? issue.path : undefined;
    if (
      !issue ||
      typeof issue !== "object" ||
      typeof issue.message !== "string" ||
      (path !== undefined &&
        (!Array.isArray(path) ||
          path.some(
            (segment) =>
              typeof segment !== "string" &&
              typeof segment !== "number" &&
              typeof segment !== "symbol",
          )))
    ) {
      throw new TypeError(
        `service result validator for ${identity.contract}.${identity.method} returned an invalid issue`,
      );
    }
  }
  if (issues.length) {
    throw new ServiceResultValidationError(
      identity.runtimeId,
      identity.contract,
      identity.method,
      issues,
    );
  }
}
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
export interface AgentProviderCatalogModel {
  readonly id: string;
  readonly displayName?: string;
  readonly providerOptions?: JsonObject;
}

/**
 * Provider Type 只描述配置与 AI SDK Provider 工厂。
 *
 * Provider 实例保持为泛型对象，避免把 AI SDK 的版本化类型带入 SeaShard
 * Contract；实际注册表会在 Core Host 内校验其 Provider 结构。
 */
export interface AiProviderType<
  TSettings extends JsonObject = JsonObject,
  TProvider extends object = object,
> {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema: JsonObject;
  readonly catalog?: readonly AgentProviderCatalogModel[];
  create(input: {
    readonly connectionId: string;
    readonly settings: TSettings;
    readonly apiKey?: string;
  }): TProvider;
  discoverModels?(input: {
    readonly settings: TSettings;
    readonly apiKey?: string;
    readonly signal: AbortSignal;
  }): Promise<readonly AgentProviderCatalogModel[]>;
}

/** 保留具体设置与 Provider 的类型推导；生命周期仍由 PluginContext 接管。 */
export function defineAiProviderType<TSettings extends JsonObject, TProvider extends object>(
  definition: AiProviderType<TSettings, TProvider>,
): AiProviderType<TSettings, TProvider> {
  return definition;
}

export interface PluginContext {
  readonly execution: ExecutionContext;
  readonly runtimeId: string;
  readonly storage: PluginStorage;
  effect(execute: () => Awaitable<Disposable | void>, label?: string): void;
  provide(contract: string, provider: ServiceProvider, options?: ServiceProvideOptions): void;
  service<T extends object>(contract: string): T;
  contribute(kind: string, value: JsonValue): string;
  agentTool(definition: AgentToolDefinition, execute: AgentToolHandler): string;
  agentResources(resources: AgentResourceMap): void;
  aiProviderType<TSettings extends JsonObject, TProvider extends object>(
    definition: AiProviderType<TSettings, TProvider>,
  ): string;
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
