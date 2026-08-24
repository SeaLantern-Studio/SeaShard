import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAiProviderType, type JsonObject, type PluginContext } from "@seashard/plugin-sdk";

type SharedHttpSettings = JsonObject & {
  readonly baseURL?: string;
  readonly headers?: Record<string, string>;
};

type OpenAISettings = SharedHttpSettings & {
  readonly organization?: string;
  readonly project?: string;
};

type OpenAICompatibleSettings = SharedHttpSettings & {
  readonly baseURL: string;
  readonly queryParams?: Record<string, string>;
  readonly includeUsage?: boolean;
  readonly supportsStructuredOutputs?: boolean;
};

const stringMapSchema: JsonObject = {
  type: "object",
  additionalProperties: { type: "string" },
};

const sharedHttpProperties: JsonObject = {
  baseURL: { type: "string", minLength: 1 },
  headers: stringMapSchema,
};

export const openAiProviderType = defineAiProviderType<
  OpenAISettings,
  ReturnType<typeof createOpenAI>
>({
  id: "openai",
  displayName: "OpenAI",
  settingsSchema: {
    type: "object",
    properties: {
      ...sharedHttpProperties,
      organization: { type: "string", minLength: 1 },
      project: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
  create: ({ connectionId, settings, apiKey }) =>
    createOpenAI({
      name: connectionId,
      ...(apiKey ? { apiKey } : {}),
      ...(settings.baseURL ? { baseURL: normalizeHttpBaseUrl(settings.baseURL) } : {}),
      ...(settings.headers ? { headers: settings.headers } : {}),
      ...(settings.organization ? { organization: settings.organization } : {}),
      ...(settings.project ? { project: settings.project } : {}),
    }),
});

export const anthropicProviderType = defineAiProviderType<
  SharedHttpSettings,
  ReturnType<typeof createAnthropic>
>({
  id: "anthropic",
  displayName: "Anthropic",
  settingsSchema: {
    type: "object",
    properties: sharedHttpProperties,
    additionalProperties: false,
  },
  create: ({ connectionId, settings, apiKey }) =>
    createAnthropic({
      name: connectionId,
      ...(apiKey ? { apiKey } : {}),
      ...(settings.baseURL ? { baseURL: normalizeHttpBaseUrl(settings.baseURL) } : {}),
      ...(settings.headers ? { headers: settings.headers } : {}),
    }),
});

export const googleProviderType = defineAiProviderType<
  SharedHttpSettings,
  ReturnType<typeof createGoogle>
>({
  id: "google",
  displayName: "Google Generative AI",
  settingsSchema: {
    type: "object",
    properties: sharedHttpProperties,
    additionalProperties: false,
  },
  create: ({ connectionId, settings, apiKey }) =>
    createGoogle({
      name: connectionId,
      ...(apiKey ? { apiKey } : {}),
      ...(settings.baseURL ? { baseURL: normalizeHttpBaseUrl(settings.baseURL) } : {}),
      ...(settings.headers ? { headers: settings.headers } : {}),
    }),
});

export const openAiCompatibleProviderType = defineAiProviderType<
  OpenAICompatibleSettings,
  ReturnType<typeof createOpenAICompatible>
>({
  id: "openai-compatible",
  displayName: "OpenAI Compatible",
  settingsSchema: {
    type: "object",
    properties: {
      ...sharedHttpProperties,
      queryParams: stringMapSchema,
      includeUsage: { type: "boolean" },
      supportsStructuredOutputs: { type: "boolean" },
    },
    required: ["baseURL"],
    additionalProperties: false,
  },
  create: ({ connectionId, settings, apiKey }) =>
    createOpenAICompatible({
      name: connectionId,
      baseURL: normalizeHttpBaseUrl(settings.baseURL),
      ...(apiKey ? { apiKey } : {}),
      ...(settings.headers ? { headers: settings.headers } : {}),
      ...(settings.queryParams ? { queryParams: settings.queryParams } : {}),
      includeUsage: settings.includeUsage ?? true,
      ...(settings.supportsStructuredOutputs === undefined
        ? {}
        : { supportsStructuredOutputs: settings.supportsStructuredOutputs }),
    }),
  discoverModels: ({ settings, apiKey, signal }) =>
    discoverOpenAICompatibleModels(settings, apiKey, signal),
});

/** 内建驱动仍走 PluginContext 注册，确保它们与组件 Fiber 同生共死。 */
export function registerBuiltInAgentProviderTypes(
  context: Pick<PluginContext, "aiProviderType">,
): void {
  context.aiProviderType(openAiProviderType);
  context.aiProviderType(anthropicProviderType);
  context.aiProviderType(googleProviderType);
  context.aiProviderType(openAiCompatibleProviderType);
}

async function discoverOpenAICompatibleModels(
  settings: OpenAICompatibleSettings,
  apiKey: string | undefined,
  signal: AbortSignal,
) {
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
