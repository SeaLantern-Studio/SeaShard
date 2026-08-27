import {
  agentModelMaximumContextTokensLimit,
  agentModelMaximumReasoningLevels,
} from "@seashard/contracts";
import type {
  AgentModelConnectionModel,
  AgentModelConnectionMutation,
  AgentModelSettings,
} from "@seashard/contracts";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";
import { parseDocument } from "yaml";
import type { AgentCredentialSource, ParsedConnection } from "./types";

export type ParsedYamlDocument = ReturnType<typeof parseDocument>;

export const emptyModelsTemplate = `# SeaShard Agent 模型供应商配置。
# providers 的映射键是稳定连接 ID；Session 只保存连接 ID 和模型 ID。
#
# providers:
#   company-gateway:
#     displayName: Company Gateway
#     providerType: openai-compatible
#     credentialId: COMPANY_GATEWAY_API_KEY
#     settings:
#       baseURL: https://gateway.example/v1
#       headers:
#         X-Team: platform
#     models:
#       - id: company-coder
#         displayName: Company Coder
#         settings:
#           maximumContextTokens: 128000
#           reasoningLevels: [low, medium, high, xhigh, max, ultra]
providers: {}
`;

const connectionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const maximumConfigBytes = 1024 * 1024;
const writerLockStaleMs = 30_000;
const maximumReasoningLevelLength = 64;

export function parseModelsFile(
  source: string,
  configPath: string,
): { readonly document: ParsedYamlDocument; readonly connections: readonly ParsedConnection[] } {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw configError(configPath, document.errors.map((error) => error.message).join("; "));
  }
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw configError(configPath, errorMessage(error));
  }
  const root = requireObject(raw, configPath, "root");
  const providers = requireObject(root.providers ?? {}, configPath, "providers");
  const connections = Object.entries(providers).map(([connectionId, value]) =>
    parseConnection(connectionId, value, configPath),
  );
  return { document, connections };
}

function parseConnection(
  connectionIdValue: string,
  value: unknown,
  configPath: string,
): ParsedConnection {
  const connectionId = requireConnectionId(connectionIdValue);
  const path = `providers.${connectionId}`;
  const object = requireObject(value, configPath, path);
  const models =
    object.models === undefined
      ? undefined
      : parseConnectionModels(object.models, configPath, path);
  return {
    id: connectionId,
    ...(object.displayName === undefined
      ? {}
      : { displayName: requireString(object.displayName, configPath, `${path}.displayName`) }),
    providerType: requireString(object.providerType, configPath, `${path}.providerType`),
    ...(object.credentialId === undefined
      ? {}
      : { credentialId: requireCredentialId(object.credentialId, configPath, path) }),
    settings:
      object.settings === undefined
        ? {}
        : requireJsonObject(object.settings, configPath, `${path}.settings`),
    ...(models === undefined ? {} : { models }),
  };
}

function parseConnectionModels(
  value: unknown,
  configPath: string,
  connectionPath: string,
): readonly AgentModelConnectionModel[] {
  if (!Array.isArray(value)) {
    throw configError(configPath, `${connectionPath}.models 必须是数组`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = `${connectionPath}.models[${index}]`;
    const object = requireObject(entry, configPath, path);
    const id = requireString(object.id, configPath, `${path}.id`);
    if (seen.has(id)) throw configError(configPath, `模型重复：${id}`);
    seen.add(id);
    return {
      id,
      ...(object.displayName === undefined
        ? {}
        : { displayName: requireString(object.displayName, configPath, `${path}.displayName`) }),
      ...(object.providerOptions === undefined
        ? {}
        : {
            providerOptions: requireJsonObject(
              object.providerOptions,
              configPath,
              `${path}.providerOptions`,
            ),
          }),
      ...(object.settings === undefined
        ? {}
        : {
            settings: parseDragonHTDevModelSettings(
              object.settings,
              configPath,
              `${path}.settings`,
            ),
          }),
    };
  });
}

/** 模型能力配置保持供应商无关；协议专用参数继续只进入 providerOptions。 */
export function parseDragonHTDevModelSettings(
  value: unknown,
  configPath: string,
  path: string,
): AgentModelSettings {
  const object = requireObject(value, configPath, path);
  const maximumContextTokens = requirePositiveTokenLimit(
    object.maximumContextTokens,
    configPath,
    `${path}.maximumContextTokens`,
  );
  if (!Array.isArray(object.reasoningLevels)) {
    throw configError(configPath, `${path}.reasoningLevels 必须是数组`);
  }
  if (
    object.reasoningLevels.length === 0 ||
    object.reasoningLevels.length > agentModelMaximumReasoningLevels
  ) {
    throw configError(
      configPath,
      `${path}.reasoningLevels 必须包含 1 到 ${agentModelMaximumReasoningLevels} 个档位`,
    );
  }
  const seen = new Set<string>();
  const reasoningLevels = object.reasoningLevels.map((level, index) => {
    const normalized = requireString(level, configPath, `${path}.reasoningLevels[${index}]`);
    if (normalized.length > maximumReasoningLevelLength) {
      throw configError(
        configPath,
        `${path}.reasoningLevels[${index}] 不能超过 ${maximumReasoningLevelLength} 个字符`,
      );
    }
    if (seen.has(normalized)) {
      throw configError(configPath, `${path}.reasoningLevels 包含重复档位：${normalized}`);
    }
    seen.add(normalized);
    return normalized;
  });
  const maximumOutputTokens =
    object.maximumOutputTokens === undefined
      ? undefined
      : requirePositiveTokenLimit(
          object.maximumOutputTokens,
          configPath,
          `${path}.maximumOutputTokens`,
        );
  const inputModalities =
    object.inputModalities === undefined
      ? undefined
      : parseInputModalities(object.inputModalities, configPath, `${path}.inputModalities`);
  const api =
    object.api === undefined ? undefined : requireString(object.api, configPath, `${path}.api`);
  const cost =
    object.cost === undefined ? undefined : parseModelCost(object.cost, configPath, `${path}.cost`);
  return {
    maximumContextTokens,
    ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
    reasoningLevels,
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(api === undefined ? {} : { api }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function requirePositiveTokenLimit(value: unknown, configPath: string, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > agentModelMaximumContextTokensLimit
  ) {
    throw configError(
      configPath,
      `${path} 必须是 1 到 ${agentModelMaximumContextTokensLimit} 的整数`,
    );
  }
  return value;
}

function parseInputModalities(
  value: unknown,
  configPath: string,
  path: string,
): readonly ("text" | "image")[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw configError(configPath, `${path} 必须是非空数组`);
  }
  const modalities = value.map((entry, index) => {
    if (entry !== "text" && entry !== "image") {
      throw configError(configPath, `${path}[${index}] 只支持 text 或 image`);
    }
    return entry;
  });
  if (new Set(modalities).size !== modalities.length) {
    throw configError(configPath, `${path} 不能包含重复项`);
  }
  return modalities;
}

function parseModelCost(
  value: unknown,
  configPath: string,
  path: string,
): NonNullable<AgentModelSettings["cost"]> {
  const object = requireObject(value, configPath, path);
  const read = (field: "input" | "output" | "cacheRead" | "cacheWrite"): number => {
    const amount = object[field];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw configError(configPath, `${path}.${field} 必须是非负有限数`);
    }
    return amount;
  };
  return {
    input: read("input"),
    output: read("output"),
    cacheRead: read("cacheRead"),
    cacheWrite: read("cacheWrite"),
  };
}

export function normalizeMutations(
  value: readonly AgentModelConnectionMutation[],
): readonly AgentModelConnectionMutation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("模型连接修改必须至少包含一个操作");
  }
  return value.map((operation, index) => {
    if (!operation || typeof operation !== "object") {
      throw new TypeError(`模型连接修改 ${index + 1} 必须是对象`);
    }
    const path = normalizeMutationPath(operation.path, index);
    if (operation.op === "unset") return { op: "unset", path };
    if (operation.op !== "set") {
      throw new TypeError(`模型连接修改 ${index + 1} 的 op 不受支持`);
    }
    return { op: "set", path, value: requireJsonValue(operation.value, "模型连接修改值") };
  });
}

function normalizeMutationPath(value: readonly string[], index: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new TypeError(`模型连接修改 ${index + 1} 的 path 长度无效`);
  }
  const path = value.map((segment) => {
    if (
      typeof segment !== "string" ||
      !segment ||
      segment.length > 64 ||
      segment === "__proto__" ||
      segment === "prototype" ||
      segment === "constructor"
    ) {
      throw new TypeError(`模型连接修改 ${index + 1} 包含无效路径段`);
    }
    return segment;
  });
  if (!["displayName", "providerType", "credentialId", "settings", "models"].includes(path[0]!)) {
    throw new TypeError(`模型连接修改 ${index + 1} 不能修改字段 ${path[0]}`);
  }
  return path;
}

export function requireRevision(value: unknown): string {
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new TypeError("模型供应商配置 revision 无效");
  }
  return value;
}

export function requireConnectionId(value: unknown): string {
  if (typeof value !== "string" || !connectionIdPattern.test(value)) {
    throw new TypeError(`模型供应商连接 ID 无效：${String(value)}`);
  }
  return value;
}

function requireCredentialId(value: unknown, configPath: string, path: string): string {
  try {
    return requireCredentialReference(value);
  } catch (error) {
    throw configError(configPath, `${path}.credentialId 格式无效：${errorMessage(error)}`);
  }
}

export function requireCredentialReference(value: unknown): string {
  const id = requireNonEmptyText(value, "credentialId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new TypeError(`credentialId 格式无效：${id}`);
  }
  return id;
}

export function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

export function requireJsonObject(value: unknown, configPath: string, path: string): JsonObject {
  const normalized = requireJsonValue(value, path);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw configError(configPath, `${path} 必须是对象`);
  }
  return normalized;
}

export function requireJsonValue(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${path} 只能包含 JSON 值`);
  if (ancestors.has(value)) throw new TypeError(`${path} 不能循环引用`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) => requireJsonValue(entry, `${path}[${index}]`, nextAncestors));
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} 必须是普通 JSON 对象`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      requireJsonValue(entry, `${path}.${key}`, nextAncestors),
    ]),
  );
}

function requireObject(value: unknown, configPath: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(configPath, `${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, configPath: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw configError(configPath, `${path} 必须是非空字符串`);
  }
  return value.trim();
}

export function createEnvironmentCredentialSource(
  environment: Readonly<Record<string, string | undefined>>,
): AgentCredentialSource {
  return {
    read(credentialId) {
      const value = environment[credentialId];
      return value?.trim() || undefined;
    },
  };
}

export function configError(configPath: string, message: string): Error {
  return new Error(`Agent models.yml 无效（${configPath}）：${message}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
