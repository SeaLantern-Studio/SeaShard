import {
  agentModelConfigurationContract,
  javaRuntimeManagerContract,
  serverCoreIconHost,
  serverCoreIconScheme,
  serverCoreSourceContract,
  serverInstanceIconHost,
  serverInstanceManagerContract,
  serverRuntimeContract,
  type AgentModelConfigurationSnapshot,
  type ClientEntryDescriptor,
  type ClientServiceCallRequest,
  type ServerConsoleLine,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";
import type {
  ServerWebApiError,
  ServerWebClientBootstrap,
  ServerWebBootstrapSnapshot,
  ServerWebClientServiceResponse,
  ServerWebEvent,
} from "@seashard/server-web-api";
import type {
  ClientUiPackageModuleLoader,
  ClientUiServiceAdapter,
  ClientUiServiceAdapterContext,
} from "@seashard/ui-runtime";

const sha256Pattern = /^[a-f0-9]{64}$/u;
export interface ServerWebCredentials {
  readonly username: string;
  readonly password: string;
}

type AuthenticationRequiredListener = () => void;
const authenticationRequiredListeners = new Set<AuthenticationRequiredListener>();

export class ServerWebRequestError extends Error {
  readonly name = "ServerWebRequestError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function onServerWebAuthenticationRequired(
  listener: AuthenticationRequiredListener,
): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

export const webClientPackageModuleLoader: ClientUiPackageModuleLoader = {
  load: async (moduleUrl, integrity) => {
    const url = new URL(moduleUrl, window.location.origin);
    if (
      !sha256Pattern.test(integrity) ||
      url.origin !== window.location.origin ||
      !url.pathname.startsWith(`/api/client-assets/${integrity}/`) ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(`invalid Server Web Client module URL: ${moduleUrl}`);
    }
    return import(/* @vite-ignore */ url.href);
  },
};
/** 普通方法回到 Kernel 做 Entry 身份和 permissions 校验；浏览器专属能力在适配器中收口。 */
export function createServerWebServiceAdapters(
  events: ServerWebEvents,
): Readonly<Record<string, ClientUiServiceAdapter>> {
  return {
    [serverCoreSourceContract]: (context) => createWebAssetServiceProxy(context),
    [serverInstanceManagerContract]: (context) =>
      createWebAssetServiceProxy(context, { list: "listForClient" }),
    [serverRuntimeContract]: (context) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            if (property === "then") return undefined;
            if (property === "onConsoleLine") {
              return (listener: (line: ServerConsoleLine) => void) =>
                context.effect(() => events.subscribeConsole(listener));
            }
            if (typeof property !== "string") return undefined;
            return (...args: JsonValue[]) => context.call(property, args);
          },
        },
      ),
    [agentModelConfigurationContract]: (context) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            if (property === "then") return undefined;
            if (property === "onConfigurationChanged") {
              return (listener: (configuration: AgentModelConfigurationSnapshot) => void) =>
                context.effect(() => events.subscribeAgentModelConfiguration(listener));
            }
            if (typeof property !== "string") return undefined;
            return (...args: JsonValue[]) => context.call(property, args);
          },
        },
      ),
    // Web 端不能替 Host 弹出文件选择器；保留扫描、禁用和手动记录移除，页面据缺失的 add 隐藏添加入口。
    [javaRuntimeManagerContract]: (context) => ({
      scan: () => context.call("scan", []),
      remove: (executablePath: string) => context.call("remove", [executablePath]),
      setDisabled: (installationId: string, disabled: boolean) =>
        context.call("setDisabled", [installationId, disabled]),
    }),
  };
}

/**
 * Web 端把 Host 的受限本地图片协议换成本源 HTTP 端点；其他字符串保持原值。
 * 仅在子节点发生变化时复制容器，避免普通 Service 响应产生无意义的深拷贝。
 */
function projectServerWebAssetUrls(value: JsonValue | void): JsonValue | void {
  if (typeof value === "string") return serverWebAssetUrl(value);
  if (Array.isArray(value)) {
    let projected: JsonValue[] | undefined;
    value.forEach((item, index) => {
      const next = projectServerWebAssetUrls(item) as JsonValue;
      if (next === item) return;
      projected ??= [...value];
      projected[index] = next;
    });
    return projected ?? value;
  }
  if (!value || typeof value !== "object") return value;

  let projected: Record<string, JsonValue> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = projectServerWebAssetUrls(item) as JsonValue;
    if (next === item) continue;
    projected ??= { ...value };
    projected[key] = next;
  }
  return projected ?? value;
}

function createWebAssetServiceProxy(
  context: ClientUiServiceAdapterContext,
  methodAliases: Readonly<Record<string, string>> = {},
): object {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then") return undefined;
        if (typeof property !== "string") return undefined;
        return async (...args: JsonValue[]) =>
          projectServerWebAssetUrls(await context.call(methodAliases[property] ?? property, args));
      },
    },
  );
}

function serverWebAssetUrl(value: string): string {
  if (!value.startsWith(`${serverCoreIconScheme}://`)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== `${serverCoreIconScheme}:` || url.search || url.hash) return value;
  if (url.hostname === serverCoreIconHost) {
    const sha256 = /^\/([a-f0-9]{64})$/u.exec(url.pathname)?.[1];
    return sha256 ? `/api/server-assets/core-icons/${sha256}` : value;
  }
  if (url.hostname !== serverInstanceIconHost) return value;
  let instanceId: string;
  try {
    instanceId = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return value;
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/u.test(instanceId)
    ? `/api/server-assets/instance-icons/${encodeURIComponent(instanceId)}`
    : value;
}

export class ServerWebEvents {
  private readonly consoleListeners = new Set<(line: ServerConsoleLine) => void>();
  private readonly agentModelConfigurationListeners = new Set<
    (configuration: AgentModelConfigurationSnapshot) => void
  >();
  private source?: EventSource;

  subscribeConsole(listener: (line: ServerConsoleLine) => void): () => void {
    this.consoleListeners.add(listener);
    this.ensureConnected();
    return () => {
      this.consoleListeners.delete(listener);
      this.closeWhenUnused();
    };
  }

  subscribeAgentModelConfiguration(
    listener: (configuration: AgentModelConfigurationSnapshot) => void,
  ): () => void {
    this.agentModelConfigurationListeners.add(listener);
    this.ensureConnected();
    return () => {
      this.agentModelConfigurationListeners.delete(listener);
      this.closeWhenUnused();
    };
  }

  close(): void {
    this.source?.close();
    this.source = undefined;
  }

  private closeWhenUnused(): void {
    if (this.consoleListeners.size === 0 && this.agentModelConfigurationListeners.size === 0) {
      this.close();
    }
  }

  private ensureConnected(): void {
    if (this.source) return;
    const source = new EventSource("/api/events");
    this.source = source;
    source.addEventListener("console-line", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const event = parseServerWebEvent(message.data);
      if (event?.type !== "console-line") return;
      for (const listener of this.consoleListeners) listener(event.line);
    });
    source.addEventListener("agent-model-configuration", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const event = parseServerWebEvent(message.data);
      if (event?.type !== "agent-model-configuration") return;
      for (const listener of this.agentModelConfigurationListeners) {
        listener(event.configuration);
      }
    });
  }
}

export async function loadServerClientBootstrap(): Promise<ServerWebClientBootstrap> {
  return parseClientBootstrap(await requestJson("/api/client/bootstrap"));
}

export async function loadServerWebAuthentication(): Promise<ServerWebBootstrapSnapshot> {
  return parseAuthenticationBootstrap(await requestJson("/api/bootstrap"));
}

export async function authenticateServerWeb(
  credentials: ServerWebCredentials,
  setupRequired: boolean,
): Promise<ServerWebBootstrapSnapshot> {
  return parseAuthenticationBootstrap(
    await requestJson(setupRequired ? "/api/setup" : "/api/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    }),
  );
}

export async function logoutServerWeb(): Promise<void> {
  await requestJson("/api/logout", { method: "POST", body: "{}" });
}

export async function callServerClientService(
  request: ClientServiceCallRequest,
): Promise<JsonValue | void> {
  const response = parseClientServiceResponse(
    await requestJson("/api/client/services", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
  return response.resultUndefined ? undefined : response.result;
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = parseApiError(value);
    if (response.status === 401) {
      for (const listener of authenticationRequiredListeners) listener();
    }
    throw new ServerWebRequestError(
      response.status,
      error?.error.code ?? "REQUEST_FAILED",
      error?.error.message ?? `Server Web 请求失败：HTTP ${response.status}`,
    );
  }
  return value;
}

function parseAuthenticationBootstrap(value: unknown): ServerWebBootstrapSnapshot {
  const record = requireRecord(value, "Authentication bootstrap");
  if (
    record.apiVersion !== 1 ||
    typeof record.setupRequired !== "boolean" ||
    typeof record.authenticated !== "boolean" ||
    (record.username !== undefined && typeof record.username !== "string")
  ) {
    throw new TypeError("Server Web authentication bootstrap is invalid");
  }
  return {
    apiVersion: 1,
    setupRequired: record.setupRequired,
    authenticated: record.authenticated,
    ...(typeof record.username === "string" ? { username: record.username } : {}),
  };
}

function parseClientBootstrap(value: unknown): ServerWebClientBootstrap {
  const record = requireRecord(value, "Client bootstrap");
  if (
    record.apiVersion !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    !Array.isArray(record.entries)
  ) {
    throw new TypeError("Server Web Client bootstrap is invalid");
  }
  return {
    apiVersion: 1,
    revision: record.revision as number,
    entries: record.entries.map(parseClientEntry),
  };
}

function parseClientEntry(value: unknown): ClientEntryDescriptor {
  const record = requireRecord(value, "Client entry");
  const module = requireRecord(record.module, "Client entry module");
  const source = requireString(module.source, "module source");
  if (source !== "builtin" && source !== "package") {
    throw new TypeError("Client entry module source is invalid");
  }
  const moduleReference: ClientEntryDescriptor["module"] =
    source === "builtin"
      ? { source: "builtin", key: requireString(module.key, "module key") }
      : { source: "package", url: requireString(module.url, "module URL") };
  const scopeType = requireString(record.scopeType, "scope type");
  if (
    scopeType !== "global" &&
    scopeType !== "workspace" &&
    scopeType !== "server" &&
    scopeType !== "agent" &&
    scopeType !== "client-session"
  ) {
    throw new TypeError("Client entry scope type is invalid");
  }
  const integrity = requireString(record.integrity, "integrity");
  if (!sha256Pattern.test(integrity)) throw new TypeError("Client entry integrity is invalid");
  return {
    runtimeId: requireString(record.runtimeId, "runtimeId"),
    pluginId: requireString(record.pluginId, "pluginId"),
    pluginVersion: requireString(record.pluginVersion, "pluginVersion"),
    entryId: requireString(record.entryId, "entryId"),
    module: moduleReference,
    integrity,
    scopeType,
    scopeId: requireString(record.scopeId, "scopeId"),
    config: parseJsonValue(record.config, 0),
  };
}

function parseClientServiceResponse(value: unknown): ServerWebClientServiceResponse {
  const record = requireRecord(value, "Client service response");
  if (typeof record.resultUndefined !== "boolean") {
    throw new TypeError("Client service response flag is invalid");
  }
  return {
    resultUndefined: record.resultUndefined,
    ...(record.resultUndefined ? {} : { result: parseJsonValue(record.result, 0) }),
  };
}

function parseApiError(value: unknown): ServerWebApiError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  if (typeof value.error.code !== "string" || typeof value.error.message !== "string") {
    return undefined;
  }
  return { error: { code: value.error.code, message: value.error.message } };
}

function parseServerWebEvent(source: string): ServerWebEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "agent-model-configuration") {
    return {
      type: "agent-model-configuration",
      configuration: parseAgentModelConfiguration(value.configuration),
    };
  }
  if (value.type !== "console-line") return undefined;
  const line = value.line;
  if (
    !isRecord(line) ||
    !Number.isSafeInteger(line.sequence) ||
    typeof line.instanceId !== "string" ||
    (line.stream !== "stdout" &&
      line.stream !== "stderr" &&
      line.stream !== "input" &&
      line.stream !== "system") ||
    typeof line.text !== "string" ||
    typeof line.timestamp !== "string"
  ) {
    return undefined;
  }
  return {
    type: "console-line",
    line: {
      sequence: line.sequence as number,
      instanceId: line.instanceId,
      stream: line.stream,
      text: line.text,
      timestamp: line.timestamp,
    },
  };
}

function parseAgentModelConfiguration(value: unknown): AgentModelConfigurationSnapshot {
  const configuration = requireRecord(parseJsonValue(value, 0), "Agent model configuration");
  if (
    typeof configuration.revision !== "string" ||
    !Array.isArray(configuration.connections) ||
    !Array.isArray(configuration.models) ||
    !Array.isArray(configuration.providerTypes) ||
    !Array.isArray(configuration.diagnostics) ||
    !configuration.diagnostics.every((diagnostic) => typeof diagnostic === "string")
  ) {
    throw new TypeError("Agent model configuration event is invalid");
  }
  return configuration as unknown as AgentModelConfigurationSnapshot;
}

function parseJsonValue(value: unknown, depth: number): JsonValue {
  if (depth > 32) throw new TypeError("JSON value nesting is too deep");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => parseJsonValue(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, parseJsonValue(item, depth + 1)]),
    );
  }
  throw new TypeError("value is not JSON serializable");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
