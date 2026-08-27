import type {
  AgentProviderCatalogModel,
  AiProviderType,
  JsonObject,
  JsonValue,
  ScopeAddress,
} from "@seashard/plugin-sdk";
import { compileJsonSchemaValidator } from "../json-schema";
import {
  normalizeAgentJsonObject,
  normalizeAgentJsonValue,
  requireAgentResourceText,
} from "./shared";

interface AgentProviderTypeRegistration {
  readonly id: string;
  readonly runtimeId: string;
  readonly scope: ScopeAddress;
  readonly definition: NormalizedAgentProviderType;
  readonly validateSettings: (value: JsonValue) => void;
  active: boolean;
}

interface NormalizedAgentProviderType {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema: JsonObject;
  readonly catalog?: readonly AgentProviderCatalogModel[];
  create(input: {
    readonly connectionId: string;
    readonly settings: JsonObject;
    readonly apiKey?: string;
  }): object;
  discoverModels?(input: {
    readonly settings: JsonObject;
    readonly apiKey?: string;
    readonly signal: AbortSignal;
  }): Promise<readonly AgentProviderCatalogModel[]>;
}

export interface AgentProviderTypeSnapshot extends NormalizedAgentProviderType {
  validateSettings(settings: JsonObject): void;
}

export interface AgentProviderTypeRegistrySnapshot {
  readonly definitions: readonly AgentProviderTypeSnapshot[];
  resolve(id: string): AgentProviderTypeSnapshot | undefined;
}

/**
 * Provider Type 只保存当前 Core Host 中可执行的 pi-ai Provider 工厂。
 *
 * 配置文档和凭据不进入注册表；快照仅冻结一次投影所用的类型集合。组件卸载后，
 * 既有快照会拒绝再次创建 Provider，防止越过 Cordis Fiber 生命周期。
 */
export class AgentProviderTypeRegistry {
  private readonly registrations = new Map<string, AgentProviderTypeRegistration>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;

  register<TSettings extends JsonObject, TProvider extends object>(
    runtimeId: string,
    scope: ScopeAddress,
    definition: AiProviderType<TSettings, TProvider>,
  ): { id: string; dispose: () => void } {
    if (scope.type !== "global" || scope.id !== "global") {
      throw new Error("AI Provider Type 只能注册到 global:global");
    }
    const normalized = normalizeAgentProviderTypeDefinition(definition);
    const existing = this.registrations.get(normalized.id);
    if (existing) {
      throw new Error(`AI Provider Type ${normalized.id} 已由 ${existing.runtimeId} 注册`);
    }
    const registration: AgentProviderTypeRegistration = {
      id: `${runtimeId}:ai-provider-type:${++this.counter}`,
      runtimeId,
      scope: { ...scope },
      definition: normalized,
      validateSettings: compileJsonSchemaValidator(
        normalized.settingsSchema,
        `AI Provider Type ${normalized.id} 设置`,
      ),
      active: true,
    };
    this.registrations.set(normalized.id, registration);
    this.publishChanged();
    return {
      id: registration.id,
      dispose: () => this.remove(registration),
    };
  }

  snapshot(): AgentProviderTypeRegistrySnapshot {
    const definitions = [...this.registrations.values()]
      .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
      .map((registration) => this.project(registration));
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    return {
      definitions,
      resolve: (id) => byId.get(id),
    };
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  private project(registration: AgentProviderTypeRegistration): AgentProviderTypeSnapshot {
    const definition = registration.definition;
    const assertActive = () => {
      if (!registration.active) {
        throw new Error(`AI Provider Type 已停止：${definition.id}`);
      }
    };
    return {
      id: definition.id,
      displayName: definition.displayName,
      settingsSchema: structuredClone(definition.settingsSchema),
      ...(definition.catalog
        ? { catalog: definition.catalog.map((model) => structuredClone(model)) }
        : {}),
      validateSettings: (settings) => {
        assertActive();
        registration.validateSettings(settings);
      },
      create: (input) => {
        assertActive();
        registration.validateSettings(input.settings);
        return definition.create(input);
      },
      ...(definition.discoverModels
        ? {
            discoverModels: async (input: {
              readonly settings: JsonObject;
              readonly apiKey?: string;
              readonly signal: AbortSignal;
            }) => {
              assertActive();
              registration.validateSettings(input.settings);
              return normalizeAgentProviderCatalog(
                await definition.discoverModels!(input),
                definition.id,
              );
            },
          }
        : {}),
    };
  }

  private remove(registration: AgentProviderTypeRegistration): void {
    if (!registration.active) return;
    registration.active = false;
    if (this.registrations.get(registration.definition.id) === registration) {
      this.registrations.delete(registration.definition.id);
    }
    this.publishChanged();
  }

  private publishChanged(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalizeAgentProviderTypeDefinition<
  TSettings extends JsonObject,
  TProvider extends object,
>(definition: AiProviderType<TSettings, TProvider>): NormalizedAgentProviderType {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("AI Provider Type 定义必须是对象");
  }
  if (typeof definition.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(definition.id)) {
    throw new TypeError(`AI Provider Type ID 不合法：${String(definition.id)}`);
  }
  const displayName = requireAgentResourceText(definition.displayName, "Provider Type 显示名称");
  const settingsSchema = normalizeAgentJsonValue(
    definition.settingsSchema,
    `AI Provider Type ${definition.id} settingsSchema`,
  );
  if (
    settingsSchema === null ||
    typeof settingsSchema !== "object" ||
    Array.isArray(settingsSchema)
  ) {
    throw new TypeError(`AI Provider Type ${definition.id} settingsSchema 必须是对象`);
  }
  if (typeof definition.create !== "function") {
    throw new TypeError(`AI Provider Type ${definition.id} 缺少 create 工厂`);
  }
  if (definition.discoverModels !== undefined && typeof definition.discoverModels !== "function") {
    throw new TypeError(`AI Provider Type ${definition.id} discoverModels 必须是函数`);
  }
  const catalog =
    definition.catalog === undefined
      ? undefined
      : normalizeAgentProviderCatalog(definition.catalog, definition.id);
  return {
    id: definition.id,
    displayName,
    settingsSchema,
    ...(catalog ? { catalog } : {}),
    create: (input) =>
      definition.create({
        ...input,
        settings: input.settings as TSettings,
      }),
    ...(definition.discoverModels
      ? {
          discoverModels: (input) =>
            definition.discoverModels!({
              ...input,
              settings: input.settings as TSettings,
            }),
        }
      : {}),
  };
}

function normalizeAgentProviderCatalog(
  value: readonly AgentProviderCatalogModel[],
  providerTypeId: string,
): readonly AgentProviderCatalogModel[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`AI Provider Type ${providerTypeId} catalog 必须是数组`);
  }
  const seen = new Set<string>();
  return value.map((model, index) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new TypeError(`AI Provider Type ${providerTypeId} catalog[${index}] 必须是对象`);
    }
    const id = requireAgentResourceText(model.id, `Provider Type 模型 ${index + 1} ID`);
    if (seen.has(id)) {
      throw new TypeError(`AI Provider Type ${providerTypeId} 的 Catalog 模型重复：${id}`);
    }
    seen.add(id);
    const displayName =
      model.displayName === undefined
        ? undefined
        : requireAgentResourceText(model.displayName, `Provider Type 模型 ${index + 1} 显示名称`);
    const settings =
      model.settings === undefined
        ? undefined
        : normalizeAgentJsonObject(
            model.settings,
            `AI Provider Type ${providerTypeId} catalog[${index}].settings`,
          );
    const providerOptions =
      model.providerOptions === undefined
        ? undefined
        : normalizeAgentJsonObject(
            model.providerOptions,
            `AI Provider Type ${providerTypeId} catalog[${index}].providerOptions`,
          );
    return {
      id,
      ...(displayName ? { displayName } : {}),
      ...(settings ? { settings } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  });
}
