import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentConfiguredModel, AgentModelApi, AgentModelSelection } from "@seashard/contracts";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";
import type { LanguageModel } from "ai";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

export const agentModelsFileName = "models.yml";
export type AgentProviderOptions = Record<string, JsonObject>;

export interface ResolvedAgentModel {
  readonly selection: AgentModelSelection;
  readonly languageModel: LanguageModel;
  readonly providerOptions?: AgentProviderOptions;
}

interface ParsedModel extends AgentConfiguredModel {
  readonly headers: Readonly<Record<string, string>>;
  readonly providerOptions?: AgentProviderOptions;
}

interface ParsedProvider {
  readonly id: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly auth: "apiKey" | "none";
  readonly api?: AgentModelApi;
  readonly headers: Readonly<Record<string, string>>;
  readonly models: readonly ParsedModel[];
}

interface CatalogSnapshot {
  readonly fingerprint: string;
  readonly providers: readonly ParsedProvider[];
  readonly models: readonly AgentConfiguredModel[];
}

const emptyModelsTemplate = `# SeaShard Agent 模型配置。
# 字段结构参考 OMP models.yml；第一个供应商的第一个模型作为默认模型。
#
# providers:
#   openai:
#     api: openai-responses
#     apiKey: OPENAI_API_KEY
#     models:
#       - id: gpt-5.4
#         name: GPT-5.4
#
#   local-openai:
#     baseUrl: http://127.0.0.1:8000/v1
#     auth: none
#     api: openai-completions
#     models:
#       - id: Qwen/Qwen3-Coder
#         name: Qwen 3 Coder
providers: {}
`;

/** 读取 <userData>/agent/models.yml，并在每次调用前按文件指纹刷新模型目录。 */
export class AgentModelCatalog {
  readonly configPath: string;

  private readonly environment: Readonly<Record<string, string | undefined>>;
  private snapshot?: CatalogSnapshot;

  constructor(options: {
    readonly userDataRoot: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }) {
    this.configPath = join(options.userDataRoot, "agent", agentModelsFileName);
    this.environment = options.environment ?? process.env;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await writeFile(this.configPath, emptyModelsTemplate, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await this.refresh();
  }

  async list(): Promise<readonly AgentConfiguredModel[]> {
    return (await this.refresh()).models.map((model) => ({ ...model }));
  }

  async resolve(selection?: AgentModelSelection): Promise<ResolvedAgentModel> {
    const snapshot = await this.refresh();
    const selected = selection ?? snapshot.models[0];
    if (!selected) throw new Error(`Agent 模型尚未配置：${this.configPath}`);

    const provider = snapshot.providers.find((candidate) => candidate.id === selected.connectionId);
    const model = provider?.models.find((candidate) => candidate.modelId === selected.modelId);
    if (!provider || !model) {
      throw new Error(`Agent 模型不存在：${selected.connectionId}/${selected.modelId}`);
    }
    return {
      selection: { connectionId: provider.id, modelId: model.modelId },
      languageModel: createLanguageModel(provider, model, this.environment, this.configPath),
      ...(model.providerOptions ? { providerOptions: model.providerOptions } : {}),
    };
  }

  private async refresh(): Promise<CatalogSnapshot> {
    const metadata = await stat(this.configPath);
    const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
    if (this.snapshot?.fingerprint === fingerprint) return this.snapshot;

    const source = await readFile(this.configPath, "utf8");
    const providers = parseModelsFile(source, this.configPath);
    const models = providers.flatMap((provider) =>
      provider.models.map((model) => ({
        connectionId: provider.id,
        modelId: model.modelId,
        name: model.name,
        api: model.api,
      })),
    );
    const snapshot = { fingerprint, providers, models };
    this.snapshot = snapshot;
    return snapshot;
  }
}

function parseModelsFile(source: string, configPath: string): readonly ParsedProvider[] {
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
  return Object.entries(providers).map(([providerId, value]) =>
    parseProvider(providerId, value, configPath),
  );
}

function parseProvider(providerId: string, value: unknown, configPath: string): ParsedProvider {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
    throw configError(configPath, `供应商 ID 无效：${providerId}`);
  }
  const path = `providers.${providerId}`;
  const object = requireObject(value, configPath, path);
  const api = optionalApi(object.api, configPath, `${path}.api`);
  const rawModels = object.models ?? [];
  if (!Array.isArray(rawModels)) throw configError(configPath, `${path}.models 必须是数组`);
  const models = rawModels.map((model, index) =>
    parseModel(providerId, model, api, configPath, `${path}.models[${index}]`),
  );
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.modelId)) {
      throw configError(configPath, `模型重复：${providerId}/${model.modelId}`);
    }
    seen.add(model.modelId);
  }
  const auth = object.auth === undefined ? "apiKey" : requireAuth(object.auth, configPath, path);
  const apiKey = optionalString(object.apiKey, configPath, `${path}.apiKey`);
  if (apiKey?.startsWith("!")) {
    throw configError(configPath, `${path}.apiKey 不支持执行命令`);
  }
  const baseUrl = optionalUrl(object.baseUrl, configPath, `${path}.baseUrl`);
  return {
    id: providerId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(api ? { api } : {}),
    auth,
    headers: parseStringRecord(object.headers, configPath, `${path}.headers`),
    models,
  };
}

function parseModel(
  connectionId: string,
  value: unknown,
  providerApi: AgentModelApi | undefined,
  configPath: string,
  path: string,
): ParsedModel {
  const object = requireObject(value, configPath, path);
  const modelId = requireString(object.id, configPath, `${path}.id`);
  const api = optionalApi(object.api, configPath, `${path}.api`) ?? providerApi;
  if (!api) throw configError(configPath, `${path}.api 或供应商 api 必须配置`);
  return {
    connectionId,
    modelId,
    name: optionalString(object.name, configPath, `${path}.name`) ?? modelId,
    api,
    headers: parseStringRecord(object.headers, configPath, `${path}.headers`),
    ...(object.providerOptions === undefined
      ? {}
      : {
          providerOptions: parseProviderOptions(
            object.providerOptions,
            configPath,
            `${path}.providerOptions`,
          ),
        }),
  };
}

function createLanguageModel(
  provider: ParsedProvider,
  model: ParsedModel,
  environment: Readonly<Record<string, string | undefined>>,
  configPath: string,
): LanguageModel {
  const apiKey = resolveApiKey(provider, model.api, environment, configPath);
  const headers = { ...provider.headers, ...model.headers };
  if (model.api === "openai-completions") {
    if (provider.baseUrl) {
      return createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        includeUsage: true,
      })(model.modelId);
    }
    if (!apiKey) throw configError(configPath, `${provider.id} 需要 API Key`);
    return createOpenAI({
      name: provider.id,
      apiKey,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }).chat(model.modelId);
  }
  if (provider.auth === "none") {
    throw configError(configPath, `${provider.id} 的 auth: none 仅支持 OpenAI 兼容接口`);
  }
  if (!apiKey) throw configError(configPath, `${provider.id} 需要 API Key`);
  if (model.api === "openai-responses") {
    return createOpenAI({
      name: provider.id,
      apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }).responses(model.modelId);
  }
  if (model.api === "anthropic-messages") {
    return createAnthropic({
      name: provider.id,
      apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }).messages(model.modelId);
  }
  return createGoogle({
    name: provider.id,
    apiKey,
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }).languageModel(model.modelId);
}

function resolveApiKey(
  provider: ParsedProvider,
  api: AgentModelApi,
  environment: Readonly<Record<string, string | undefined>>,
  configPath: string,
): string | undefined {
  if (provider.auth === "none") return undefined;
  if (provider.apiKey) return environment[provider.apiKey]?.trim() || provider.apiKey;
  const environmentName =
    api === "anthropic-messages"
      ? "ANTHROPIC_API_KEY"
      : api === "google-generative-ai"
        ? "GOOGLE_GENERATIVE_AI_API_KEY"
        : "OPENAI_API_KEY";
  const value = environment[environmentName]?.trim();
  if (!value) {
    throw configError(configPath, `${provider.id}.apiKey 或 ${environmentName} 必须配置`);
  }
  return value;
}

function optionalApi(value: unknown, configPath: string, path: string): AgentModelApi | undefined {
  if (value === undefined) return undefined;
  if (
    value === "openai-completions" ||
    value === "openai-responses" ||
    value === "anthropic-messages" ||
    value === "google-generative-ai"
  ) {
    return value;
  }
  throw configError(configPath, `${path} 使用了尚未支持的 API`);
}

function requireAuth(value: unknown, configPath: string, path: string): "apiKey" | "none" {
  if (value === "apiKey" || value === "none") return value;
  throw configError(configPath, `${path}.auth 必须是 apiKey 或 none`);
}

function optionalUrl(value: unknown, configPath: string, path: string): string | undefined {
  const raw = optionalString(value, configPath, path);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError(configPath, `${path} 必须是绝对 HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configError(configPath, `${path} 必须使用 HTTP 或 HTTPS`);
  }
  return raw.replace(/\/+$/, "");
}

function parseStringRecord(
  value: unknown,
  configPath: string,
  path: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const object = requireObject(value, configPath, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [
      key,
      requireString(entry, configPath, `${path}.${key}`),
    ]),
  );
}

function parseProviderOptions(
  value: unknown,
  configPath: string,
  path: string,
): AgentProviderOptions {
  const object = requireObject(value, configPath, path);
  return Object.fromEntries(
    Object.entries(object).map(([providerId, options]) => [
      providerId,
      requireJsonObject(options, configPath, `${path}.${providerId}`),
    ]),
  );
}

function requireJsonObject(value: unknown, configPath: string, path: string): JsonObject {
  const object = requireObject(value, configPath, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [
      key,
      requireJsonValue(entry, configPath, `${path}.${key}`),
    ]),
  );
}

function requireJsonValue(value: unknown, configPath: string, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => requireJsonValue(entry, configPath, `${path}[${index}]`));
  }
  if (value && typeof value === "object") return requireJsonObject(value, configPath, path);
  throw configError(configPath, `${path} 只能包含 JSON 值`);
}

function requireObject(value: unknown, configPath: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(configPath, `${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, configPath: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw configError(configPath, `${path} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(value: unknown, configPath: string, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, configPath, path);
}

function configError(configPath: string, message: string): Error {
  return new Error(`Agent models.yml 无效（${configPath}）：${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
