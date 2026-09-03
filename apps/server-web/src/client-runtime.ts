import {
  javaRuntimeManagerContract,
  serverRuntimeContract,
  type ClientEntryDescriptor,
  type ClientServiceCallRequest,
  type ServerConsoleLine,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";
import type {
  ServerWebApiError,
  ServerWebClientBootstrap,
  ServerWebClientServiceResponse,
  ServerWebEvent,
} from "@seashard/server-web-api";
import type { ClientUiPackageModuleLoader, ClientUiServiceAdapter } from "@seashard/ui-runtime";

const sha256Pattern = /^[a-f0-9]{64}$/u;

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
  events: ServerWebConsoleEvents,
): Readonly<Record<string, ClientUiServiceAdapter>> {
  return {
    [serverRuntimeContract]: (context) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            if (property === "then") return undefined;
            if (property === "onConsoleLine") {
              return (listener: (line: ServerConsoleLine) => void) =>
                context.effect(() => events.subscribe(listener));
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

export class ServerWebConsoleEvents {
  private readonly listeners = new Set<(line: ServerConsoleLine) => void>();
  private source?: EventSource;

  subscribe(listener: (line: ServerConsoleLine) => void): () => void {
    this.listeners.add(listener);
    this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  close(): void {
    this.source?.close();
    this.source = undefined;
  }

  private ensureConnected(): void {
    if (this.source) return;
    const source = new EventSource("/api/events");
    this.source = source;
    source.addEventListener("console-line", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const event = parseServerWebEvent(message.data);
      if (event?.type !== "console-line") return;
      for (const listener of this.listeners) listener(event.line);
    });
  }
}

export async function loadServerClientBootstrap(): Promise<ServerWebClientBootstrap> {
  return parseClientBootstrap(await requestJson("/api/client/bootstrap"));
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
    throw new Error(error?.error.message ?? `Server Web 请求失败：HTTP ${response.status}`);
  }
  return value;
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
  if (!isRecord(value) || value.type !== "console-line") return undefined;
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
