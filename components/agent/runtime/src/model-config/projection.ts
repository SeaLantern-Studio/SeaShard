import type { Api, Model } from "@earendil-works/pi-ai";
import { defaultAgentModelReasoningLevels } from "@seashard/contracts";
import type {
  AgentModelConfigurationSnapshot,
  AgentModelConnectionConfig,
  AgentModelConnectionModel,
  AgentProviderTypeDescriptor,
} from "@seashard/contracts";
import type { AgentProviderCatalogModel, JsonObject } from "@seashard/plugin-sdk";
import type { AgentPiProviderConnection } from "../provider-types";
import {
  configError,
  parseDragonHTDevModelSettings,
  requireJsonObject,
  requireJsonValue,
  requireString,
} from "./document";
import type {
  AgentProviderOptions,
  AgentProviderTypeSnapshot,
  CatalogSnapshot,
  EffectiveModel,
  ParsedConnection,
} from "./types";

export function resolveConnectionModels(
  connection: ParsedConnection,
  catalog: readonly AgentProviderCatalogModel[] | undefined,
  configPath: string,
): readonly AgentModelConnectionModel[] {
  const catalogModels = catalog
    ? normalizeProviderCatalogModels(
        catalog,
        configPath,
        `Provider Type ${connection.providerType}`,
      )
    : [];
  if (!connection.models?.length && catalogModels.length === 0) {
    throw configError(
      configPath,
      `providers.${connection.id} 必须声明 models，或使用带内建 Catalog 的 Provider Type`,
    );
  }
  if (!connection.models) return catalogModels;
  const byId = new Map(catalogModels.map((model) => [model.id, model]));
  return connection.models.map((configured) => {
    const base = byId.get(configured.id);
    return {
      id: configured.id,
      ...((configured.displayName ?? base?.displayName)
        ? { displayName: configured.displayName ?? base?.displayName }
        : {}),
      ...((configured.providerOptions ?? base?.providerOptions)
        ? { providerOptions: structuredClone(configured.providerOptions ?? base?.providerOptions!) }
        : {}),
      ...((configured.settings ?? base?.settings)
        ? { settings: structuredClone(configured.settings ?? base?.settings!) }
        : {}),
    };
  });
}

export function projectConnection(
  connection: ParsedConnection,
  credentialConfigured: boolean,
  available: boolean,
  diagnostic?: string,
): AgentModelConnectionConfig {
  return {
    id: connection.id,
    ...(connection.displayName ? { displayName: connection.displayName } : {}),
    providerType: connection.providerType,
    ...(connection.credentialId ? { credentialId: connection.credentialId } : {}),
    credentialConfigured,
    settings: structuredClone(connection.settings),
    ...(connection.models
      ? { models: connection.models.map((model) => structuredClone(model)) }
      : {}),
    available,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function projectProviderTypes(
  definitions: readonly AgentProviderTypeSnapshot[],
  configPath: string,
): readonly AgentProviderTypeDescriptor[] {
  return definitions.map((definition) => ({
    id: definition.id,
    displayName: definition.displayName,
    settingsSchema: structuredClone(definition.settingsSchema),
    ...(definition.catalog
      ? {
          catalog: normalizeProviderCatalogModels(
            definition.catalog,
            configPath,
            `Provider Type ${definition.id}`,
          ),
        }
      : {}),
    supportsModelDiscovery: definition.discoverModels !== undefined,
  }));
}

export function normalizeDiscoveredModels(
  value: readonly AgentProviderCatalogModel[],
  providerTypeId: string,
  configPath: string,
): readonly AgentModelConnectionModel[] {
  return normalizeProviderCatalogModels(
    value,
    configPath,
    `AI Provider Type ${providerTypeId} 模型发现结果`,
  );
}

function normalizeProviderCatalogModels(
  value: readonly AgentProviderCatalogModel[],
  configPath: string,
  label: string,
): readonly AgentModelConnectionModel[] {
  if (!Array.isArray(value)) throw configError(configPath, `${label} 必须是数组`);
  const seen = new Set<string>();
  return value.map((model, index) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw configError(configPath, `${label}[${index}] 必须是对象`);
    }
    const id = requireString(model.id, configPath, `${label}[${index}].id`);
    if (seen.has(id)) throw configError(configPath, `${label} 返回了重复模型：${id}`);
    seen.add(id);
    return {
      id,
      ...(model.displayName
        ? { displayName: requireString(model.displayName, configPath, `${label}[${index}].name`) }
        : {}),
      ...(model.providerOptions
        ? {
            providerOptions: requireJsonObject(
              model.providerOptions,
              configPath,
              `${label}[${index}].providerOptions`,
            ),
          }
        : {}),
      ...(model.settings
        ? {
            settings: parseDragonHTDevModelSettings(
              model.settings,
              configPath,
              `${label}[${index}].settings`,
            ),
          }
        : {}),
    };
  });
}

export function normalizeJsonObject(value: unknown, label: string): JsonObject {
  const normalized = requireJsonValue(value, label);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return normalized;
}

export function assertAgentPiProviderConnection(
  value: object,
  connectionId: string,
): AgentPiProviderConnection {
  const candidate = value as Partial<AgentPiProviderConnection>;
  if (
    candidate.kind !== "pi-ai" ||
    !candidate.provider ||
    typeof candidate.provider.id !== "string" ||
    !candidate.models ||
    typeof candidate.models.streamSimple !== "function"
  ) {
    throw new TypeError(`连接 ${connectionId} 的 Provider Type 没有返回有效的 pi-ai 连接`);
  }
  return value as AgentPiProviderConnection;
}

export function clonePiModel(model: Model<Api>): Model<Api> {
  return structuredClone(model);
}

export function normalizeProviderOptions(
  value: JsonObject,
  connectionId: string,
  modelId: string,
): AgentProviderOptions {
  return Object.fromEntries(
    Object.entries(value).map(([providerId, options]) => {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError(
          `模型 ${connectionId}/${modelId} 的 providerOptions.${providerId} 必须是对象`,
        );
      }
      return [providerId, structuredClone(options)];
    }),
  );
}

/**
 * 未显式选择时落在离散档位的中间偏左点。六档默认配置会落到 high，
 * 同时保证奇偶数量的供应商档位都有稳定初值。
 */
export function resolveSelectedReasoningLevel(
  model: EffectiveModel,
  selected: string | undefined,
): string {
  const levels = model.settings?.reasoningLevels ?? defaultAgentModelReasoningLevels;
  const reasoningLevel = selected ?? levels[Math.floor((levels.length - 1) / 2)];
  if (!reasoningLevel || !levels.includes(reasoningLevel)) {
    throw new Error(
      `Agent 模型 ${model.connectionId}/${model.modelId} 不支持推理档位：${selected ?? ""}`,
    );
  }
  return reasoningLevel;
}

/**
 * 第一版 models.yml 的 providerOptions 按供应商名分组。切换驱动后仍读取该结构，
 * 只把当前连接对应的对象展开为 pi-ai 请求选项；推理档位由专用映射负责。
 */
export function resolveRequestOptions(model: EffectiveModel): JsonObject | undefined {
  const configured = model.providerOptions;
  if (!configured) return undefined;
  const keys = [...new Set(["pi-ai", model.providerType, model.connectionId])];
  const matched = keys.flatMap((key) => (configured[key] ? [configured[key]] : []));
  const sources =
    matched.length > 0
      ? matched
      : Object.values(configured).length === 1
        ? Object.values(configured)
        : [];
  if (sources.length === 0) return undefined;
  const merged = Object.assign({}, ...sources) as JsonObject;
  delete merged.reasoningEffort;
  delete merged.reasoning_effort;
  return Object.keys(merged).length > 0 ? structuredClone(merged) : undefined;
}

export function semanticDiagnostics(snapshot: CatalogSnapshot): readonly string[] {
  return snapshot.configuration.connections.flatMap((connection) =>
    connection.diagnostic ? [connection.diagnostic] : [],
  );
}

export function cloneConfiguration(
  snapshot: AgentModelConfigurationSnapshot,
): AgentModelConfigurationSnapshot {
  return structuredClone(snapshot);
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
