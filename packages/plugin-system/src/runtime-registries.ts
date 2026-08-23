import { defaultAgentResourcePresentationTitle } from "@seashard/plugin-sdk";
import type {
  AgentActivityPresentationField,
  AgentResource,
  AgentResourceDefinition,
  AgentResourceExecutionContext,
  AgentResourceImplementation,
  AgentResourceReadRequest,
  AgentResourceReadResult,
  AgentResourceUri,
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolHandler,
  Awaitable,
  ExecutionContext,
  JsonObject,
  JsonValue,
  ScopeAddress,
  ServiceProvider,
} from "@seashard/plugin-sdk";
import { compileJsonSchemaValidator } from "./json-schema";

interface ServiceRegistration {
  contract: string;
  runtimeId: string;
  scope: ScopeAddress;
  provider: ServiceProvider;
}

interface ContributionRegistration {
  id: string;
  kind: string;
  runtimeId: string;
  scope: ScopeAddress;
  value: JsonValue;
}

interface EventRegistration {
  event: string;
  runtimeId: string;
  scope: ScopeAddress;
  handler: (payload: JsonValue) => Awaitable<void>;
}

interface AgentToolRegistration {
  readonly id: string;
  readonly runtimeId: string;
  readonly scope: ScopeAddress;
  readonly name: string;
  readonly definition: AgentToolDefinition;
  readonly handler: AgentToolHandler;
  active: boolean;
}

export interface AgentToolSnapshot {
  readonly name: string;
  readonly definition: AgentToolDefinition;
  execute(input: JsonValue, context: AgentToolExecutionContext): Promise<JsonValue>;
}

interface CompiledAgentResourcePattern {
  readonly scheme: string;
  readonly segments: readonly AgentResourcePatternSegment[];
  readonly shape: string;
  readonly staticSegmentCount: number;
}

type AgentResourcePatternSegment =
  | { readonly type: "static"; readonly value: string }
  | { readonly type: "parameter"; readonly name: string };

interface AgentResourceRegistration {
  readonly id: string;
  readonly runtimeId: string;
  readonly scope: ScopeAddress;
  readonly definition: AgentResourceDefinition;
  readonly implementation: AgentResourceImplementation;
  readonly route: CompiledAgentResourcePattern;
  readonly validateInput: (value: JsonValue) => void;
  active: boolean;
}

export interface AgentResourcePreparedRead {
  readonly definition: AgentResourceDefinition;
  readonly request: AgentResourceReadRequest;
  presentRequest(): Promise<readonly AgentActivityPresentationField[] | undefined>;
  read(context?: AgentResourceExecutionContext): Promise<AgentResourceReadResult>;
  presentResult(
    result: AgentResourceReadResult,
  ): Promise<readonly AgentActivityPresentationField[] | undefined>;
}

export interface AgentResourceRegistrySnapshot {
  readonly definitions: readonly AgentResourceDefinition[];
  prepare(path: string, input: JsonValue): AgentResourcePreparedRead;
  read(
    path: string,
    input: JsonValue,
    context?: AgentResourceExecutionContext,
  ): Promise<AgentResourceReadResult>;
}
export interface ContributionSnapshot {
  id: string;
  kind: string;
  runtimeId: string;
  scope: ScopeAddress;
  value: JsonValue;
}

/**
 * 运行时注册表只保存当前 Cordis Fiber 的公开内容。
 *
 * 注册随着 Fiber 的 effect 自动撤销，不再复制 Publication、Lease 或
 * Generation 状态，也不把运行态写入数据库。
 */
export class ServiceRegistry {
  private readonly registrations = new Map<string, Set<ServiceRegistration>>();

  register(
    contract: string,
    runtimeId: string,
    scope: ScopeAddress,
    provider: ServiceProvider,
  ): () => void {
    validateContract(contract);
    const methods = Object.entries(provider);
    if (methods.length === 0 || methods.some(([, method]) => typeof method !== "function")) {
      throw new TypeError(`service provider ${contract} must expose callable methods`);
    }
    const registration: ServiceRegistration = { contract, runtimeId, scope, provider };
    let set = this.registrations.get(contract);
    if (!set) {
      set = new Set();
      this.registrations.set(contract, set);
    }
    if (
      [...set].some(
        (candidate) =>
          candidate.runtimeId === runtimeId &&
          candidate.scope.type === scope.type &&
          candidate.scope.id === scope.id,
      )
    ) {
      throw new Error(
        `service ${contract} is already registered by ${runtimeId} in ${scope.type}:${scope.id}`,
      );
    }
    set.add(registration);
    return () => {
      set?.delete(registration);
      if (set?.size === 0) this.registrations.delete(contract);
    };
  }

  has(contract: string, execution?: ExecutionContext): boolean {
    const set = this.registrations.get(contract);
    if (!set) return false;
    return execution ? this.select(contract, execution) !== undefined : set.size > 0;
  }

  async call(
    contract: string,
    method: string,
    args: JsonValue[],
    execution: ExecutionContext,
  ): Promise<JsonValue | void> {
    if (execution.actorType !== "core" && !allowsPermission(execution.permissions, contract)) {
      throw new Error(`actor ${execution.actorId} is not allowed to call ${contract}`);
    }
    const registration = this.select(contract, execution);
    if (!registration) throw new Error(`no service provider available: ${contract}`);
    const target = registration.provider[method];
    if (typeof target !== "function")
      throw new Error(`service method does not exist: ${contract}.${method}`);
    return target(...args);
  }

  removeRuntime(runtimeId: string): void {
    for (const [contract, set] of this.registrations) {
      for (const registration of set) {
        if (registration.runtimeId === runtimeId) set.delete(registration);
      }
      if (set.size === 0) this.registrations.delete(contract);
    }
  }

  countRuntime(runtimeId?: string): number {
    let count = 0;
    for (const set of this.registrations.values()) {
      for (const registration of set) {
        if (!runtimeId || registration.runtimeId === runtimeId) count += 1;
      }
    }
    return count;
  }

  private select(contract: string, execution: ExecutionContext): ServiceRegistration | undefined {
    const set = this.registrations.get(contract);
    if (!set) return undefined;
    const chain = execution.scopeChain;
    let selected: ServiceRegistration | undefined;
    let selectedRank = -1;
    for (const registration of set) {
      const rank = chain.findIndex(
        (scope) => scope.type === registration.scope.type && scope.id === registration.scope.id,
      );
      if (rank < 0) continue;
      if (rank === selectedRank) {
        throw new Error(
          `ambiguous providers for ${contract} in ${registration.scope.type}:${registration.scope.id}`,
        );
      }
      if (rank > selectedRank) {
        selected = registration;
        selectedRank = rank;
      }
    }
    return selected;
  }
}

/**
 * Agent 工具属于声明组件的运行时资源。快照保留稳定处理器，但组件停止后拒绝继续执行，
 * 防止已开始的 Agent Invocation 穿透已经销毁的 Cordis Fiber。
 */
export class AgentToolRegistry {
  private readonly registrations = new Map<string, AgentToolRegistration>();
  private counter = 0;

  register(
    runtimeId: string,
    scope: ScopeAddress,
    definition: AgentToolDefinition,
    handler: AgentToolHandler,
  ): { id: string; dispose: () => void } {
    if (typeof handler !== "function") throw new TypeError("Agent 工具处理器必须是函数");
    const normalized = normalizeAgentToolDefinition(definition);
    const name = `${normalized.namespace}_${normalized.name}`;
    const existing = this.registrations.get(name);
    if (existing) {
      throw new Error(`Agent 工具 ${name} 已由 ${existing.runtimeId} 注册`);
    }

    const registration: AgentToolRegistration = {
      id: `${runtimeId}:agent-tool:${++this.counter}`,
      runtimeId,
      scope: { ...scope },
      name,
      definition: normalized,
      handler,
      active: true,
    };
    this.registrations.set(name, registration);
    return {
      id: registration.id,
      dispose: () => this.remove(registration),
    };
  }

  /** 每次 Invocation 开始时读取一次，保证单次模型闭环使用同一组工具。 */
  snapshot(): AgentToolSnapshot[] {
    return [...this.registrations.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((registration) => ({
        name: registration.name,
        definition: registration.definition,
        execute: async (input, context) => {
          if (!registration.active) {
            throw new Error(`Agent 工具已停止：${registration.name}`);
          }
          return registration.handler(input, context);
        },
      }));
  }

  removeRuntime(runtimeId: string): void {
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) this.remove(registration);
    }
  }

  countRuntime(runtimeId?: string): number {
    if (!runtimeId) return this.registrations.size;
    let count = 0;
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) count += 1;
    }
    return count;
  }

  private remove(registration: AgentToolRegistration): void {
    if (!registration.active) return;
    registration.active = false;
    if (this.registrations.get(registration.name) === registration) {
      this.registrations.delete(registration.name);
    }
  }
}

/**
 * Agent 资源注册表编译 URI 模式并生成 Invocation 级路由快照。
 * 快照固定路由集合；声明组件停止后，既有快照也会拒绝继续读取其资源。
 */
export class AgentResourceRegistry {
  private readonly registrations = new Map<string, AgentResourceRegistration>();
  private counter = 0;

  register(
    runtimeId: string,
    scope: ScopeAddress,
    pattern: string,
    resource: AgentResource,
  ): { id: string; dispose: () => void } {
    const normalized = normalizeAgentResource(pattern, resource);
    const route = compileAgentResourcePattern(normalized.definition.pattern);
    const existing = this.registrations.get(route.shape);
    if (existing) {
      throw new Error(
        [
          `Agent 资源路由冲突：${route.shape}`,
          `已注册：${existing.definition.pattern}（${existing.runtimeId}）`,
          `新声明：${normalized.definition.pattern}（${runtimeId}）`,
        ].join("\n"),
      );
    }

    const registration: AgentResourceRegistration = {
      id: `${runtimeId}:agent-resource:${++this.counter}`,
      runtimeId,
      scope: { ...scope },
      definition: normalized.definition,
      implementation: normalized.implementation,
      route,
      validateInput: compileJsonSchemaValidator(
        normalized.definition.inputSchema,
        `Agent 资源 ${normalized.definition.pattern} `,
      ),
      active: true,
    };
    this.registrations.set(route.shape, registration);
    return {
      id: registration.id,
      dispose: () => this.remove(registration),
    };
  }

  /** 每次 Invocation 开始时读取一次，防止一次工具闭环内的路由集合漂移。 */
  snapshot(): AgentResourceRegistrySnapshot {
    const registrations = [...this.registrations.values()].sort(compareAgentResourceRoutes);
    const prepare = (path: string, input: JsonValue): AgentResourcePreparedRead => {
      const uri = parseAgentResourceUri(path);
      const matched = matchAgentResourceRegistration(registrations, uri);
      if (!matched) throw new Error(`Agent 资源不存在：${uri.href}`);
      assertAgentResourceActive(matched.registration);
      matched.registration.validateInput(input);
      const request: AgentResourceReadRequest = {
        uri,
        pathParams: matched.params,
        input,
      };
      return {
        definition: matched.registration.definition,
        request,
        presentRequest: async () => {
          assertAgentResourceActive(matched.registration);
          const { implementation } = matched.registration;
          if (!implementation.presentRequest) return undefined;
          return normalizeAgentActivityPresentationFields(
            await implementation.presentRequest(request),
          );
        },
        read: async (context = {}) => {
          assertAgentResourceActive(matched.registration);
          return normalizeAgentResourceReadResult(
            await matched.registration.implementation.read(request, context),
          );
        },
        presentResult: async (result) => {
          assertAgentResourceActive(matched.registration);
          const { implementation } = matched.registration;
          if (!implementation.presentResult) return undefined;
          return normalizeAgentActivityPresentationFields(
            await implementation.presentResult(request, result),
          );
        },
      };
    };
    return {
      definitions: registrations.map(({ definition }) => definition),
      prepare,
      read: async (path, input, context = {}) => prepare(path, input).read(context),
    };
  }

  removeRuntime(runtimeId: string): void {
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) this.remove(registration);
    }
  }

  countRuntime(runtimeId?: string): number {
    if (!runtimeId) return this.registrations.size;
    let count = 0;
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) count += 1;
    }
    return count;
  }

  private remove(registration: AgentResourceRegistration): void {
    if (!registration.active) return;
    registration.active = false;
    if (this.registrations.get(registration.route.shape) === registration) {
      this.registrations.delete(registration.route.shape);
    }
  }
}

export class ContributionRegistry {
  private readonly registrations = new Map<string, ContributionRegistration>();
  private counter = 0;

  register(
    kind: string,
    runtimeId: string,
    scope: ScopeAddress,
    value: JsonValue,
  ): { id: string; dispose: () => void } {
    validateContract(kind);
    const id = `${runtimeId}:${++this.counter}`;
    this.registrations.set(id, { id, kind, runtimeId, scope, value });
    return { id, dispose: () => this.registrations.delete(id) };
  }

  list(kind?: string): ContributionSnapshot[] {
    return [...this.registrations.values()]
      .filter((registration) => !kind || registration.kind === kind)
      .map((registration) => ({ ...registration }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  removeRuntime(runtimeId: string): void {
    for (const [id, registration] of this.registrations) {
      if (registration.runtimeId === runtimeId) this.registrations.delete(id);
    }
  }
}

export class PluginEventBus {
  private readonly registrations = new Set<EventRegistration>();

  on(
    event: string,
    runtimeId: string,
    scope: ScopeAddress,
    handler: EventRegistration["handler"],
  ): () => void {
    validateContract(event);
    const registration: EventRegistration = { event, runtimeId, scope, handler };
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  async emit(event: string, payload: JsonValue, execution: ExecutionContext): Promise<void> {
    const handlers = [...this.registrations].filter(
      (registration) =>
        registration.event === event &&
        execution.scopeChain.some(
          (scope) => scope.type === registration.scope.type && scope.id === registration.scope.id,
        ),
    );
    await Promise.all(
      handlers.map((registration) => Promise.resolve(registration.handler(payload))),
    );
  }

  removeRuntime(runtimeId: string): void {
    for (const registration of this.registrations) {
      if (registration.runtimeId === runtimeId) this.registrations.delete(registration);
    }
  }
}

export function allowsPermission(permissions: readonly string[], capability: string): boolean {
  return permissions.some(
    (permission) =>
      permission === "*" ||
      permission === capability ||
      (permission.endsWith(".*") && capability.startsWith(permission.slice(0, -1))),
  );
}

function validateContract(value: string): void {
  if (!/^[a-z0-9][a-z0-9.*:-]*$/.test(value)) {
    throw new TypeError(`invalid contract identifier: ${value}`);
  }
}

function normalizeAgentResource(
  patternValue: string,
  resource: AgentResource,
): {
  readonly definition: AgentResourceDefinition;
  readonly implementation: AgentResourceImplementation;
} {
  if (!resource || typeof resource !== "object") {
    throw new TypeError("Agent 资源必须是对象");
  }
  const pattern = requireAgentResourceText(patternValue, "路径模式");
  const description = requireAgentResourceText(resource.description, "描述");
  const inputSchema = requireAgentResourceJsonObject(resource.inputSchema, "inputSchema");
  const outputDescription =
    resource.outputDescription === undefined
      ? undefined
      : requireAgentResourceText(resource.outputDescription, "返回说明");
  const help =
    resource.help === undefined ? undefined : requireAgentResourceText(resource.help, "详细说明");
  const examples = resource.examples?.map((value, index) =>
    normalizeAgentJsonValue(value, `Agent 资源输入示例 ${index + 1}`),
  );
  const title =
    resource.presentation === undefined
      ? defaultAgentResourcePresentationTitle
      : requireAgentResourcePresentationTitle(resource.presentation, pattern);
  if (!resource.implementation || typeof resource.implementation !== "object") {
    throw new TypeError(`Agent 资源 ${pattern} 缺少 implementation`);
  }
  const implementation = resource.implementation;
  if (typeof implementation.read !== "function") {
    throw new TypeError(`Agent 资源 ${pattern} 缺少 read 实现`);
  }
  if (
    implementation.presentRequest !== undefined &&
    typeof implementation.presentRequest !== "function"
  ) {
    throw new TypeError(`Agent 资源 ${pattern} presentRequest 必须是函数`);
  }
  if (
    implementation.presentResult !== undefined &&
    typeof implementation.presentResult !== "function"
  ) {
    throw new TypeError(`Agent 资源 ${pattern} presentResult 必须是函数`);
  }
  compileAgentResourcePattern(pattern);
  return {
    definition: {
      pattern,
      description,
      inputSchema,
      ...(outputDescription === undefined ? {} : { outputDescription }),
      ...(examples === undefined ? {} : { examples }),
      ...(help === undefined ? {} : { help }),
      presentation: { title },
    },
    implementation,
  };
}

function compileAgentResourcePattern(pattern: string): CompiledAgentResourcePattern {
  const uri = parseAgentResourceUri(pattern);
  if (Object.keys(uri.query).length) {
    throw new TypeError(`Agent 资源路径模式不能包含查询参数：${pattern}`);
  }
  const segments: AgentResourcePatternSegment[] = [];
  for (const segment of splitAgentResourcePath(uri.path)) {
    const parameter = /^\{([A-Za-z][A-Za-z0-9]*)\}$/u.exec(segment);
    if (parameter) {
      segments.push({ type: "parameter", name: parameter[1]! });
      continue;
    }
    if (segment.includes("{") || segment.includes("}")) {
      throw new TypeError(`Agent 资源路径参数必须占据完整路径段：${pattern}`);
    }
    segments.push({ type: "static", value: segment });
  }
  const shape = `${uri.scheme}://${segments
    .map((segment) => (segment.type === "static" ? segment.value : "{*}"))
    .join("/")}`;
  return {
    scheme: uri.scheme,
    segments,
    shape,
    staticSegmentCount: segments.filter(({ type }) => type === "static").length,
  };
}

function parseAgentResourceUri(value: string): AgentResourceUri {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`Agent 资源 URI 不合法：${String(value)}`);
  }
  const matched = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^#]*)$/u.exec(value);
  if (!matched) throw new TypeError(`Agent 资源 URI 不合法：${value}`);
  const scheme = matched[1]!.toLowerCase();
  const remainder = matched[2]!;
  const queryIndex = remainder.indexOf("?");
  const encodedPath = queryIndex === -1 ? remainder : remainder.slice(0, queryIndex);
  const encodedQuery = queryIndex === -1 ? "" : remainder.slice(queryIndex + 1);
  if (encodedPath.startsWith("/") || encodedPath.endsWith("/") || encodedPath.includes("//")) {
    throw new TypeError(`Agent 资源 URI 路径不合法：${value}`);
  }

  const decodedSegments = encodedPath
    ? encodedPath.split("/").map((segment) => decodeAgentResourcePart(segment, value))
    : [];
  if (
    decodedSegments.some(
      (segment) =>
        !segment ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0") ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new TypeError(`Agent 资源 URI 路径不合法：${value}`);
  }

  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  const parameters = new URLSearchParams(encodedQuery);
  for (const [key, queryValue] of parameters) {
    if (!key || Object.hasOwn(query, key)) {
      throw new TypeError(`Agent 资源 URI 查询参数不合法：${value}`);
    }
    query[key] = queryValue;
  }
  return {
    href: value,
    scheme,
    path: decodedSegments.join("/"),
    query,
  };
}

function decodeAgentResourcePart(value: string, uri: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError(`Agent 资源 URI 包含无效编码：${uri}`);
  }
}

function splitAgentResourcePath(path: string): readonly string[] {
  return path ? path.split("/") : [];
}

function compareAgentResourceRoutes(
  left: AgentResourceRegistration,
  right: AgentResourceRegistration,
): number {
  return (
    right.route.staticSegmentCount - left.route.staticSegmentCount ||
    right.route.segments.length - left.route.segments.length ||
    left.definition.pattern.localeCompare(right.definition.pattern)
  );
}

function matchAgentResourceRegistration(
  registrations: readonly AgentResourceRegistration[],
  uri: AgentResourceUri,
):
  | {
      readonly registration: AgentResourceRegistration;
      readonly params: Readonly<Record<string, string>>;
    }
  | undefined {
  const pathSegments = splitAgentResourcePath(uri.path);
  for (const registration of registrations) {
    if (
      registration.route.scheme !== uri.scheme ||
      registration.route.segments.length !== pathSegments.length
    ) {
      continue;
    }
    const params: Record<string, string> = Object.create(null) as Record<string, string>;
    let matched = true;
    for (const [index, segment] of registration.route.segments.entries()) {
      const value = pathSegments[index]!;
      if (segment.type === "static") {
        if (segment.value !== value) {
          matched = false;
          break;
        }
      } else {
        params[segment.name] = value;
      }
    }
    if (matched) return { registration, params };
  }
  return undefined;
}

function assertAgentResourceActive(registration: AgentResourceRegistration): void {
  if (!registration.active) {
    throw new Error(`Agent 资源已停止：${registration.definition.pattern}`);
  }
}

function normalizeAgentResourceReadResult(value: AgentResourceReadResult): AgentResourceReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Agent 资源读取结果必须是对象");
  }
  return {
    mimeType: requireAgentResourceText(value.mimeType, "MIME 类型"),
    content: normalizeAgentJsonValue(value.content, "Agent 资源内容"),
  };
}

function normalizeAgentActivityPresentationFields(
  value: readonly AgentActivityPresentationField[],
): readonly AgentActivityPresentationField[] {
  if (!Array.isArray(value)) throw new TypeError("Agent 资源展示字段必须是数组");
  if (value.length > 8) throw new TypeError("Agent 资源展示字段不能超过 8 个");
  return value.map((field, index) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new TypeError(`Agent 资源展示字段 ${index + 1} 必须是对象`);
    }
    const label =
      field.label === undefined
        ? undefined
        : requireAgentPresentationText(field.label, `字段 ${index + 1} 标签`, 40);
    const unit =
      field.unit === undefined
        ? undefined
        : requireAgentPresentationText(field.unit, `字段 ${index + 1} 单位`, 30);
    return {
      ...(label === undefined ? {} : { label }),
      value: requireAgentPresentationText(field.value, `字段 ${index + 1} 值`, 120),
      ...(unit === undefined ? {} : { unit }),
    };
  });
}

function requireAgentResourceJsonObject(value: unknown, label: string): JsonObject {
  const normalized = normalizeAgentJsonValue(value, `Agent 资源${label}`);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError(`Agent 资源${label}必须是对象`);
  }
  return normalized;
}

function normalizeAgentJsonValue(
  value: unknown,
  label: string,
  ancestors: ReadonlySet<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${label}必须是 JSON 值`);
  if (ancestors.has(value)) throw new TypeError(`${label}不能循环引用`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeAgentJsonValue(entry, `${label}[${index}]`, nextAncestors),
    );
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label}必须是普通 JSON 对象`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeAgentJsonValue(entry, `${label}.${key}`, nextAncestors),
    ]),
  );
}

function requireAgentResourcePresentationTitle(value: unknown, pattern: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Agent 资源 ${pattern} presentation 必须是对象`);
  }
  return requireAgentPresentationText((value as { readonly title?: unknown }).title, "标题", 80);
}

function requireAgentPresentationText(value: unknown, label: string, maximum: number): string {
  const normalized = requireAgentResourceText(value, label);
  if (Array.from(normalized).length > maximum) {
    throw new TypeError(`Agent 资源${label}不能超过 ${maximum} 个字符`);
  }
  if (/<\/?[A-Za-z][^>]*>/u.test(normalized) || /\[[^\]]+\]\([^)]+\)/u.test(normalized)) {
    throw new TypeError(`Agent 资源${label}只能使用纯文本`);
  }
  return normalized;
}

function requireAgentResourceText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Agent 资源${label}不能为空`);
  }
  return value.trim();
}

function normalizeAgentToolDefinition(definition: AgentToolDefinition): AgentToolDefinition {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("Agent 工具定义必须是对象");
  }
  const namespace = validateAgentToolSegment(definition.namespace, "命名空间");
  const name = validateAgentToolSegment(definition.name, "名称");
  const title = requireAgentToolText(definition.title, "标题");
  const description = requireAgentToolText(definition.description, "描述");
  if (
    !definition.inputSchema ||
    typeof definition.inputSchema !== "object" ||
    Array.isArray(definition.inputSchema)
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 inputSchema 必须是对象`);
  }
  if (
    definition.outputDescription !== undefined &&
    (typeof definition.outputDescription !== "string" || !definition.outputDescription.trim())
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的输出描述不能为空`);
  }
  if (definition.examples !== undefined && !Array.isArray(definition.examples)) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 examples 必须是数组`);
  }
  return {
    namespace,
    name,
    title,
    description,
    inputSchema: structuredClone(definition.inputSchema) as JsonObject,
    ...(definition.outputDescription === undefined
      ? {}
      : { outputDescription: definition.outputDescription.trim() }),
    ...(definition.examples === undefined
      ? {}
      : { examples: structuredClone(definition.examples) }),
  };
}

function validateAgentToolSegment(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new TypeError(`Agent 工具${label}不合法：${String(value)}`);
  }
  return value;
}

function requireAgentToolText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Agent 工具${label}不能为空`);
  }
  return value.trim();
}
