import {
  createModels,
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  lazyApi,
  type Api,
  type AuthOperationOptions,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinProviders, radiusProvider } from "@earendil-works/pi-ai/providers/all";
import {
  defaultAgentModelMaximumContextTokens,
  type AgentModelSettings,
} from "@seashard/contracts";
import {
  defineAiProviderType,
  type AgentProviderCatalogModel,
  type JsonObject,
  type PluginContext,
} from "@seashard/plugin-sdk";

type SharedHttpSettings = JsonObject & {
  readonly baseURL?: string;
  readonly headers?: Record<string, string>;
};

type OpenAICompatibleSettings = SharedHttpSettings & {
  readonly baseURL: string;
};

/**
 * 每条 SeaShard 连接拥有独立 Models 与 CredentialStore。同一供应商的多个连接即使使用
 * 相同 Provider.id，也不会共享凭据、认证刷新锁或调用期配置。
 */
export interface AgentPiProviderConnection {
  readonly kind: "pi-ai";
  readonly provider: Provider;
  readonly models: MutableModels;
  readonly settings: SharedHttpSettings;
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const modelThinkingSlots = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
const sharedHttpProperties: JsonObject = {
  baseURL: { type: "string", minLength: 1 },
  headers: {
    type: "object",
    additionalProperties: { type: "string" },
  },
};
const sharedSettingsSchema: JsonObject = {
  type: "object",
  properties: sharedHttpProperties,
  additionalProperties: false,
};
const openAICompatibleApi = lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"));

/**
 * pi-ai Provider 是协议实现，Models 是带凭据的调用容器。这里把两者组合成 SeaShard
 * 连接级驱动，防止连接 ID 与上游 Provider ID 被错误地当作同一个命名空间。
 */
function createConnection(
  provider: Provider,
  settings: SharedHttpSettings,
  apiKey: string | undefined,
): AgentPiProviderConnection {
  const credentials = new ConnectionCredentialStore(
    provider.id,
    apiKey ? { type: "api_key", key: apiKey } : undefined,
  );
  const models = createModels({ credentials });
  models.setProvider(provider);
  return {
    kind: "pi-ai",
    provider,
    models,
    settings: structuredClone(settings),
  };
}

/**
 * 配置中的模型能力覆盖目录元数据；网络端点与请求头只落在本连接解析出的 Model 副本。
 * Provider 自身保持只读，因此公司代理与官方连接可并存且互不污染。
 */
export function resolveAgentPiModel(
  connection: AgentPiProviderConnection,
  modelId: string,
  settings: AgentModelSettings | undefined,
): Model<Api> {
  const catalogModel = connection.provider
    .getModels()
    .find((candidate) => candidate.id === modelId);
  const fallbackApi =
    settings?.api ?? connection.provider.getModels()[0]?.api ?? "openai-completions";
  const base: Model<Api> = catalogModel
    ? clonePiModel(catalogModel)
    : {
        id: modelId,
        name: modelId,
        api: fallbackApi,
        provider: connection.provider.id,
        baseUrl:
          connection.settings.baseURL ?? connection.provider.baseUrl ?? "https://api.openai.com/v1",
        reasoning: settings ? settings.reasoningLevels.some((level) => level !== "off") : true,
        input: settings?.inputModalities ? [...settings.inputModalities] : ["text"],
        cost: settings?.cost ? { ...settings.cost } : { ...zeroCost },
        contextWindow: settings?.maximumContextTokens ?? defaultAgentModelMaximumContextTokens,
        maxTokens: settings?.maximumOutputTokens ?? 16_384,
      };
  const headers = {
    ...base.headers,
    ...connection.settings.headers,
  };
  const next: Model<Api> = {
    ...base,
    name: catalogModel?.name ?? modelId,
    ...(settings?.api ? { api: settings.api } : {}),
    baseUrl: connection.settings.baseURL
      ? normalizeHttpBaseUrl(connection.settings.baseURL)
      : base.baseUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(settings
      ? {
          reasoning: settings.reasoningLevels.some((level) => level !== "off"),
          contextWindow: settings.maximumContextTokens,
          ...(settings.maximumOutputTokens === undefined
            ? {}
            : { maxTokens: settings.maximumOutputTokens }),
          ...(settings.inputModalities === undefined
            ? {}
            : { input: [...settings.inputModalities] }),
          ...(settings.cost === undefined ? {} : { cost: { ...settings.cost } }),
        }
      : {}),
  };
  if (!settings) return next;
  return {
    ...next,
    thinkingLevelMap: mapConfiguredThinkingLevels(base, settings.reasoningLevels),
  };
}

/** 用户看到供应商值；运行时只在这里反查 pi-ai 的统一强度。 */
export function resolveAgentPiThinkingLevel(
  model: Model<Api>,
  providerLevel: string,
): ThinkingLevel | undefined {
  const matched = getSupportedThinkingLevels(model).find(
    (level) => (model.thinkingLevelMap?.[level] ?? level) === providerLevel,
  );
  if (!matched) {
    throw new Error(`模型 ${model.provider}/${model.id} 不支持推理档位：${providerLevel}`);
  }
  return matched === "off" ? undefined : matched;
}

/** Provider Type 目录直接使用 pi-ai 的生成目录，避免 SeaShard 维护第二份模型清单。 */
function projectCatalog(provider: Provider): readonly AgentProviderCatalogModel[] {
  return provider.getModels().map((model) => ({
    id: model.id,
    displayName: model.name,
    settings: projectAgentPiModelSettings(model),
  }));
}

export function projectAgentPiModelSettings(model: Model<Api>): AgentModelSettings & JsonObject {
  const cost = {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
  };
  const hasPublicCost = Object.values(cost).every((value) => Number.isFinite(value) && value >= 0);
  return {
    maximumContextTokens: model.contextWindow,
    maximumOutputTokens: model.maxTokens,
    reasoningLevels: projectProviderThinkingLevels(model),
    inputModalities: [...model.input],
    api: model.api,
    // pi-ai 目录会用负数标记未知价格；该哨兵不进入公共配置，避免被界面误解为返还费用。
    ...(hasPublicCost ? { cost } : {}),
  };
}

function projectProviderThinkingLevels(model: Model<Api>): string[] {
  // 部分目录将多个统一强度映射到同一个供应商值；界面与配置只暴露去重后的真实值。
  return [
    ...new Set(
      getSupportedThinkingLevels(model).map((level) => model.thinkingLevelMap?.[level] ?? level),
    ),
  ];
}

/**
 * 目录映射优先保留供应商原始映射；手写档位再按顺序占用剩余统一槽位。这样 UI 始终
 * 展示真正发往供应商的值，内部槽位也不会泄漏到配置与会话 Contract。
 */
function mapConfiguredThinkingLevels(
  model: Model<Api>,
  configured: readonly string[],
): Partial<Record<ModelThinkingLevel, string | null>> {
  if (configured.length > modelThinkingSlots.length) {
    throw new RangeError(`pi-ai 最多支持 ${modelThinkingSlots.length} 个推理档位`);
  }
  const mapped = Object.fromEntries(modelThinkingSlots.map((slot) => [slot, null])) as Record<
    ModelThinkingLevel,
    string | null
  >;
  const available = new Set(modelThinkingSlots);
  const original = new Map<string, ModelThinkingLevel>();
  for (const slot of getSupportedThinkingLevels(model)) {
    original.set(model.thinkingLevelMap?.[slot] ?? slot, slot);
  }
  for (const value of configured) {
    const slot = original.get(value);
    if (!slot || !available.has(slot)) continue;
    mapped[slot] = value;
    available.delete(slot);
  }
  for (const value of configured) {
    if (Object.values(mapped).includes(value)) continue;
    const slot = [...available].find((candidate) => candidate !== "off") ?? [...available][0];
    if (!slot) throw new RangeError(`推理档位无法映射：${value}`);
    mapped[slot] = value;
    available.delete(slot);
  }
  return mapped;
}

function clonePiModel(model: Model<Api>): Model<Api> {
  return structuredClone(model);
}

function createBuiltinProviderType(provider: Provider) {
  const createProviderForConnection = (settings: SharedHttpSettings) =>
    provider.id === "radius" ? radiusProvider({ gateway: settings.baseURL }) : provider;
  return defineAiProviderType<SharedHttpSettings, AgentPiProviderConnection>({
    id: provider.id,
    displayName: provider.name,
    settingsSchema: sharedSettingsSchema,
    catalog: projectCatalog(provider),
    create: ({ settings, apiKey }) =>
      createConnection(createProviderForConnection(settings), settings, apiKey),
    ...(provider.refreshModels
      ? {
          discoverModels: async ({ settings, apiKey, signal }) => {
            const connectionProvider = createProviderForConnection(settings);
            const connection = createConnection(connectionProvider, settings, apiKey);
            const result = await connection.models.refresh({
              providers: [connectionProvider.id],
              allowNetwork: true,
              force: true,
              signal,
            });
            if (result.aborted) signal.throwIfAborted();
            const error = result.errors.get(connectionProvider.id);
            if (error) throw error;
            return projectCatalog(connectionProvider);
          },
        }
      : {}),
  });
}

export const openAiCompatibleProviderType = defineAiProviderType<
  OpenAICompatibleSettings,
  AgentPiProviderConnection
>({
  id: "openai-compatible",
  displayName: "OpenAI Compatible",
  settingsSchema: {
    type: "object",
    properties: sharedHttpProperties,
    required: ["baseURL"],
    additionalProperties: false,
  },
  create: ({ settings, apiKey }) => {
    const provider = createProvider<"openai-completions">({
      id: "openai-compatible",
      name: "OpenAI Compatible",
      baseUrl: normalizeHttpBaseUrl(settings.baseURL),
      ...(settings.headers ? { headers: settings.headers } : {}),
      auth: { apiKey: envApiKeyAuth("OpenAI Compatible API key", []) },
      models: [],
      api: { "openai-completions": openAICompatibleApi },
    });
    return createConnection(provider, settings, apiKey);
  },
  discoverModels: ({ settings, apiKey, signal }) =>
    discoverOpenAICompatibleModels(settings, apiKey, signal),
});

const builtinProviderTypes = builtinProviders().map(createBuiltinProviderType);

/** 内建驱动仍走 PluginContext 注册，确保它们与组件 Fiber 同生共死。 */
export function registerBuiltInAgentProviderTypes(
  context: Pick<PluginContext, "aiProviderType">,
): void {
  for (const providerType of builtinProviderTypes) context.aiProviderType(providerType);
  context.aiProviderType(openAiCompatibleProviderType);
}

async function discoverOpenAICompatibleModels(
  settings: OpenAICompatibleSettings,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<readonly AgentProviderCatalogModel[]> {
  const endpoint = `${normalizeHttpBaseUrl(settings.baseURL)}/models`;
  const response = await fetch(endpoint, {
    signal,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...settings.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`模型发现请求失败：HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    throw new Error("模型发现响应超过 1 MB");
  }
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new Error("模型发现响应超过 1 MB");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("模型发现响应不是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型发现响应必须是对象");
  }
  const data = (value as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("模型发现响应缺少 data 数组");
  const seen = new Set<string>();
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = (entry as { readonly id?: unknown }).id;
    if (typeof id !== "string" || !id.trim() || seen.has(id.trim())) return [];
    const normalized = id.trim();
    seen.add(normalized);
    return [{ id: normalized }];
  });
}

function normalizeHttpBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("供应商 baseURL 必须是绝对 HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("供应商 baseURL 必须使用 HTTP 或 HTTPS");
  }
  return value.replace(/\/+$/u, "");
}

/** 连接快照内的单供应商存储；OAuth 刷新仍按 pi-ai 的 modify 协议串行写回。 */
class ConnectionCredentialStore implements CredentialStore {
  private credential: Credential | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly providerId: string,
    credential: Credential | undefined,
  ) {
    this.credential = cloneCredential(credential);
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    return providerId === this.providerId ? cloneCredential(this.credential) : undefined;
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.credential ? [{ providerId: this.providerId, type: this.credential.type }] : [];
  }

  modify(
    providerId: string,
    mutate: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== this.providerId) {
      return Promise.reject(new Error(`连接凭据存储不包含 Provider：${providerId}`));
    }
    let result: Credential | undefined;
    const operation = this.queue.then(async () => {
      const next = await mutate(cloneCredential(this.credential));
      if (next !== undefined) this.credential = cloneCredential(next);
      result = cloneCredential(this.credential);
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.then(() => result);
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    if (providerId !== this.providerId) return;
    await this.modify(providerId, async () => {
      this.credential = undefined;
      return undefined;
    });
  }
}

function cloneCredential(value: Credential | undefined): Credential | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
