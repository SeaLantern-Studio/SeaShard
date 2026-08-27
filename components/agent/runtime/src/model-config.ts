import {
  agentModelMaximumContextTokensLimit,
  agentModelMaximumReasoningLevels,
  defaultAgentModelReasoningLevels,
} from "@seashard/contracts";
import type {
  AgentConfiguredModel,
  AgentModelConfigurationSnapshot,
  AgentModelConnectionConfig,
  AgentModelConnectionModel,
  AgentModelConnectionMutation,
  AgentModelSelection,
  AgentModelSettings,
  AgentProviderTypeDescriptor,
} from "@seashard/contracts";
import type { AgentProviderCatalogModel, JsonObject, JsonValue } from "@seashard/plugin-sdk";
import { createProviderRegistry, type LanguageModel } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseDocument } from "yaml";

export const agentModelsFileName = "models.yml";
export type AgentProviderOptions = Record<string, JsonObject>;
type AgentPortableReasoningLevel =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type AiSdkProvider = Parameters<typeof createProviderRegistry>[0][string];
type ParsedYamlDocument = ReturnType<typeof parseDocument>;

export interface ResolvedAgentModel {
  readonly selection: AgentModelSelection;
  readonly languageModel: LanguageModel;
  readonly providerOptions?: AgentProviderOptions;
  readonly reasoning?: AgentPortableReasoningLevel;
}

export interface AgentProviderTypeSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema: JsonObject;
  readonly catalog?: readonly AgentProviderCatalogModel[];
  validateSettings(settings: JsonObject): void;
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

export interface AgentProviderTypeSource {
  snapshot(): {
    readonly definitions: readonly AgentProviderTypeSnapshot[];
    resolve(id: string): AgentProviderTypeSnapshot | undefined;
  };
  onChanged(listener: () => void): () => void;
}

export interface AgentCredentialSource {
  initialize?(): Promise<void>;
  read(credentialId: string): string | undefined;
  write?(credentialId: string, value: string): Promise<void>;
  remove?(credentialId: string): Promise<void>;
  onChanged?(listener: () => void): () => void;
  dispose?(): Promise<void>;
}

interface ParsedConnection {
  readonly id: string;
  readonly displayName?: string;
  readonly providerType: string;
  readonly credentialId?: string;
  readonly settings: JsonObject;
  readonly models?: readonly AgentModelConnectionModel[];
}

interface EffectiveModel extends AgentConfiguredModel {
  readonly providerType: string;
  readonly providerOptions?: AgentProviderOptions;
}

interface CatalogSnapshot {
  readonly revision: string;
  readonly source: string;
  readonly registry: ReturnType<typeof createProviderRegistry>;
  readonly models: readonly EffectiveModel[];
  readonly configuration: AgentModelConfigurationSnapshot;
  readonly loadedAt: string;
}

const emptyModelsTemplate = `# SeaShard Agent 模型供应商配置。
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

export class AgentModelConfigurationConflictError extends Error {
  readonly code = "AGENT_MODEL_CONFIGURATION_CONFLICT";

  constructor() {
    super("模型供应商配置已被其他窗口或外部编辑器修改，请重新载入后再保存。");
    this.name = "AgentModelConfigurationConflictError";
  }
}

/**
 * models.yml 的唯一 Host 所有者。
 *
 * 该类把文件、Provider Type 与凭据一次性投影成不可变 Provider Registry。任何候选
 * 投影失败都会保留上一份可调用快照；运行中的 Invocation 已持有 LanguageModel，
 * 后续文件变化只影响下一次 resolve()。
 */
export class AgentModelCatalog {
  readonly configPath: string;

  private readonly credentials: AgentCredentialSource;
  private readonly providerTypes: AgentProviderTypeSource;
  private readonly watchDebounceMs: number;
  private readonly openConfiguration?: (path: string) => Promise<void>;
  private readonly reportError: (error: unknown) => void;
  private readonly listeners = new Set<(snapshot: AgentModelConfigurationSnapshot) => void>();
  private snapshot?: CatalogSnapshot;
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private operationQueue: Promise<void> = Promise.resolve();
  private disposeProviderTypes?: () => void;
  private disposeCredentials?: () => void;
  private initialized = false;
  private disposed = false;

  constructor(options: {
    readonly userDataRoot: string;
    readonly providerTypes: AgentProviderTypeSource;
    readonly credentials?: AgentCredentialSource;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly watchDebounceMs?: number;
    readonly openConfigurationFile?: (path: string) => Promise<void>;
    readonly reportError?: (error: unknown) => void;
  }) {
    this.configPath = join(options.userDataRoot, "agent", agentModelsFileName);
    this.providerTypes = options.providerTypes;
    this.credentials =
      options.credentials ?? createEnvironmentCredentialSource(options.environment ?? process.env);
    this.watchDebounceMs = options.watchDebounceMs ?? 100;
    if (!Number.isSafeInteger(this.watchDebounceMs) || this.watchDebounceMs < 0) {
      throw new RangeError("模型配置监听稳定窗口必须是非负安全整数");
    }
    this.openConfiguration = options.openConfigurationFile;
    this.reportError =
      options.reportError ?? ((error) => console.error("Agent model configuration failed", error));
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    if (this.initialized) return;
    await this.credentials.initialize?.();
    try {
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
      await this.enqueue(async () => {
        await this.reloadFromDisk(true);
      });
      this.disposeProviderTypes = this.providerTypes.onChanged(() => this.scheduleReprojection());
      this.disposeCredentials = this.credentials.onChanged?.(() => this.scheduleReprojection());
      this.startWatcher();
      this.initialized = true;
    } catch (error) {
      await this.credentials.dispose?.();
      throw error;
    }
  }

  async list(): Promise<readonly AgentConfiguredModel[]> {
    this.assertReady();
    return this.current().models.map(
      ({ providerType: _providerType, providerOptions: _options, ...model }) => ({
        ...model,
      }),
    );
  }

  async resolve(selection?: AgentModelSelection): Promise<ResolvedAgentModel> {
    this.assertReady();
    const snapshot = this.current();
    const selected = selection ?? snapshot.models[0];
    if (!selected) throw new Error(`Agent 模型尚未配置：${this.configPath}`);
    const model = snapshot.models.find(
      (candidate) =>
        candidate.connectionId === selected.connectionId && candidate.modelId === selected.modelId,
    );
    if (!model) {
      throw new Error(`Agent 模型不存在：${selected.connectionId}/${selected.modelId}`);
    }
    const reasoningLevel = resolveSelectedReasoningLevel(model, selected.reasoningLevel);
    const invocationOptions = resolveReasoningOptions(model, reasoningLevel);
    return {
      selection: {
        connectionId: model.connectionId,
        modelId: model.modelId,
        reasoningLevel,
      },
      languageModel: snapshot.registry.languageModel(`${model.connectionId}:${model.modelId}`),
      ...invocationOptions,
    };
  }

  async getConfiguration(): Promise<AgentModelConfigurationSnapshot> {
    this.assertReady();
    return cloneConfiguration(this.current().configuration);
  }

  mutateConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
    readonly operations: readonly AgentModelConnectionMutation[];
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertReady();
    const expectedRevision = requireRevision(input.expectedRevision);
    const connectionId = requireConnectionId(input.connectionId);
    const operations = normalizeMutations(input.operations);
    return this.enqueue(async () =>
      this.writeDocument(expectedRevision, (document) => {
        for (const operation of operations) {
          const path = ["providers", connectionId, ...operation.path];
          if (operation.op === "set") document.setIn(path, structuredClone(operation.value));
          else document.deleteIn(path);
        }
      }),
    );
  }

  removeConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertReady();
    const expectedRevision = requireRevision(input.expectedRevision);
    const connectionId = requireConnectionId(input.connectionId);
    return this.enqueue(async () =>
      this.writeDocument(expectedRevision, (document) => {
        if (!document.hasIn(["providers", connectionId])) {
          throw new Error(`模型供应商连接不存在：${connectionId}`);
        }
        document.deleteIn(["providers", connectionId]);
      }),
    );
  }
  resetConfiguration(input: {
    readonly expectedRevision: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertReady();
    const expectedRevision = requireRevision(input.expectedRevision);
    return this.enqueue(async () =>
      withWriterLock(this.configPath, async () => {
        const currentBytes = await readBoundedFile(this.configPath);
        if (digest(currentBytes) !== expectedRevision) {
          throw new AgentModelConfigurationConflictError();
        }
        const nextBytes = Buffer.from(emptyModelsTemplate, "utf8");
        const candidate = this.buildSnapshot(emptyModelsTemplate, digest(nextBytes));
        await writeFileAtomically(this.configPath, nextBytes);
        this.accept(candidate);
        return cloneConfiguration(candidate.configuration);
      }),
    );
  }

  async discoverModels(input: {
    readonly providerType: string;
    readonly settings: JsonObject;
    readonly credentialId?: string;
    readonly credentialValue?: string;
  }): Promise<readonly AgentModelConnectionModel[]> {
    this.assertReady();
    const providerTypeId = requireNonEmptyText(input.providerType, "providerType");
    const providerType = this.providerTypes.snapshot().resolve(providerTypeId);
    if (!providerType) throw new Error(`AI Provider Type 未注册：${providerTypeId}`);
    if (!providerType.discoverModels) {
      throw new Error(`AI Provider Type 不支持模型发现：${providerTypeId}`);
    }
    const settings = normalizeJsonObject(input.settings, "模型发现 settings");
    providerType.validateSettings(settings);
    const credentialId =
      input.credentialId === undefined ? undefined : requireCredentialReference(input.credentialId);
    const credentialValue =
      input.credentialValue === undefined
        ? undefined
        : requireNonEmptyText(input.credentialValue, "credentialValue");
    if (credentialId && credentialValue) {
      throw new TypeError("模型发现不能同时使用 credentialId 和临时凭据");
    }
    const apiKey =
      credentialValue ?? (credentialId ? this.credentials.read(credentialId) : undefined);
    if (credentialId && !apiKey) {
      throw new Error(`Agent 凭据尚未配置：${credentialId}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("模型发现超时"), 30_000);
    try {
      const models = await providerType.discoverModels({
        settings,
        ...(apiKey ? { apiKey } : {}),
        signal: controller.signal,
      });
      return normalizeDiscoveredModels(models, providerTypeId);
    } finally {
      clearTimeout(timer);
    }
  }

  async writeCredential(input: {
    readonly credentialId: string;
    readonly value: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertReady();
    if (!this.credentials.write) throw new Error("当前 Host 没有可写的 Agent 凭据存储");
    const credentialId = requireCredentialReference(input.credentialId);
    if (typeof input.value !== "string" || !input.value.trim()) {
      throw new TypeError("Agent 凭据不能为空");
    }
    await this.credentials.write(credentialId, input.value);
    return this.enqueue(async () => this.reprojectCurrent());
  }

  async removeCredential(input: {
    readonly credentialId: string;
  }): Promise<AgentModelConfigurationSnapshot> {
    this.assertReady();
    if (!this.credentials.remove) throw new Error("当前 Host 没有可写的 Agent 凭据存储");
    await this.credentials.remove(requireCredentialReference(input.credentialId));
    return this.enqueue(async () => this.reprojectCurrent());
  }

  async openConfigurationFile(): Promise<void> {
    this.assertReady();
    if (!this.openConfiguration) {
      throw new Error("当前 Host 不支持打开模型供应商配置文件");
    }
    await this.openConfiguration(this.configPath);
  }

  onConfigurationChanged(
    listener: (snapshot: AgentModelConfigurationSnapshot) => void,
  ): () => void {
    this.assertReady();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = false;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.disposeProviderTypes?.();
    this.disposeCredentials?.();
    this.disposeProviderTypes = undefined;
    this.disposeCredentials = undefined;
    await this.operationQueue;
    await this.credentials.dispose?.();
    this.listeners.clear();
  }

  private startWatcher(): void {
    const fileName = basename(this.configPath);
    this.watcher = watch(dirname(this.configPath), { persistent: false }, (_event, changed) => {
      if (changed !== null && changed.toString() !== fileName) return;
      this.scheduleReload();
    });
    this.watcher.on("error", (error) => {
      void this.enqueue(async () => this.publishDiagnostic(error)).catch(this.reportError);
    });
  }

  /** 目录级监听同时覆盖原地写入与临时文件 rename 替换。 */
  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.enqueue(async () => this.reloadFromDisk(false)).catch(this.reportError);
    }, this.watchDebounceMs);
  }

  private scheduleReprojection(): void {
    if (this.disposed || !this.snapshot) return;
    void this.enqueue(async () => {
      try {
        this.reprojectCurrent();
      } catch (error) {
        this.publishDiagnostic(error);
      }
    }).catch(this.reportError);
  }

  private reprojectCurrent(): AgentModelConfigurationSnapshot {
    const current = this.current();
    const candidate = this.buildSnapshot(current.source, current.revision);
    this.accept(candidate);
    return cloneConfiguration(candidate.configuration);
  }

  private async reloadFromDisk(startup: boolean): Promise<void> {
    if (this.disposed && !startup) return;
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(this.configPath);
    } catch (error) {
      if (startup || !this.snapshot) throw error;
      this.publishDiagnostic(error);
      return;
    }
    const revision = digest(bytes);
    if (
      this.snapshot?.revision === revision &&
      this.snapshot.configuration.diagnostics.length === semanticDiagnostics(this.snapshot).length
    ) {
      return;
    }
    try {
      const source = decodeUtf8(bytes, this.configPath);
      this.accept(this.buildSnapshot(source, revision));
    } catch (error) {
      if (startup && !this.snapshot) {
        // 配置损坏不能阻止 Session 与设置 Contract 启动；保留原文件，由用户显式重置或外部修复。
        this.accept(this.buildInvalidSnapshot(bytes.toString("utf8"), revision, error));
        this.reportError(error);
        return;
      }
      this.publishDiagnostic(error);
    }
  }

  private buildInvalidSnapshot(source: string, revision: string, error: unknown): CatalogSnapshot {
    const configuration: AgentModelConfigurationSnapshot = {
      revision,
      connections: [],
      models: [],
      providerTypes: projectProviderTypes(this.providerTypes.snapshot().definitions),
      diagnostics: [errorMessage(error)],
    };
    return {
      revision,
      source,
      registry: createProviderRegistry({}),
      models: [],
      configuration,
      loadedAt: new Date().toISOString(),
    };
  }

  private buildSnapshot(source: string, revision: string): CatalogSnapshot {
    const connections = parseModelsFile(source, this.configPath).connections;
    const providerTypeSnapshot = this.providerTypes.snapshot();
    const providers: Record<string, AiSdkProvider> = Object.create(null) as Record<
      string,
      AiSdkProvider
    >;
    const models: EffectiveModel[] = [];
    const projectedConnections: AgentModelConnectionConfig[] = [];
    const diagnostics: string[] = [];

    for (const connection of connections) {
      const credential = connection.credentialId
        ? this.credentials.read(connection.credentialId)
        : undefined;
      // 显式 credentialId 缺失时不创建 Provider，避免 SDK 悄悄回退到进程环境中的同名默认变量。
      if (connection.credentialId && !credential) {
        const diagnostic = `连接 ${connection.id} 的凭据尚未配置：${connection.credentialId}`;
        diagnostics.push(diagnostic);
        projectedConnections.push(projectConnection(connection, false, false, diagnostic));
        continue;
      }
      const providerType = providerTypeSnapshot.resolve(connection.providerType);
      if (!providerType) {
        const diagnostic = `连接 ${connection.id} 的 Provider Type 未注册：${connection.providerType}`;
        diagnostics.push(diagnostic);
        projectedConnections.push(
          projectConnection(connection, Boolean(credential), false, diagnostic),
        );
        continue;
      }

      providerType.validateSettings(connection.settings);
      const configuredModels = resolveConnectionModels(
        connection,
        providerType.catalog,
        this.configPath,
      );
      const provider = assertAiSdkProvider(
        providerType.create({
          connectionId: connection.id,
          settings: structuredClone(connection.settings),
          ...(credential ? { apiKey: credential } : {}),
        }),
        connection.id,
      );
      providers[connection.id] = provider;
      projectedConnections.push(projectConnection(connection, Boolean(credential), true));
      for (const configured of configuredModels) {
        models.push({
          connectionId: connection.id,
          modelId: configured.id,
          name: configured.displayName ?? configured.id,
          ...(configured.settings ? { settings: structuredClone(configured.settings) } : {}),
          providerType: connection.providerType,
          ...(configured.providerOptions
            ? {
                providerOptions: normalizeProviderOptions(
                  configured.providerOptions,
                  connection.id,
                  configured.id,
                ),
              }
            : {}),
        });
      }
    }

    const registry = createProviderRegistry(providers);
    const configuration: AgentModelConfigurationSnapshot = {
      revision,
      connections: projectedConnections,
      models: models.map(
        ({ providerType: _providerType, providerOptions: _options, ...model }) => ({
          ...model,
        }),
      ),
      providerTypes: projectProviderTypes(providerTypeSnapshot.definitions),
      diagnostics,
    };
    return {
      revision,
      source,
      registry,
      models,
      configuration,
      loadedAt: new Date().toISOString(),
    };
  }

  private async writeDocument(
    expectedRevision: string,
    mutate: (document: ParsedYamlDocument) => void,
  ): Promise<AgentModelConfigurationSnapshot> {
    return withWriterLock(this.configPath, async () => {
      const currentBytes = await readBoundedFile(this.configPath);
      if (digest(currentBytes) !== expectedRevision) {
        throw new AgentModelConfigurationConflictError();
      }
      const currentSource = decodeUtf8(currentBytes, this.configPath);
      const document = parseModelsFile(currentSource, this.configPath).document;
      mutate(document);
      const nextSource = document.toString({ lineWidth: 0 });
      const nextBytes = Buffer.from(nextSource, "utf8");
      if (nextBytes.byteLength > maximumConfigBytes) {
        throw new RangeError("Agent models.yml 不能超过 1 MB");
      }
      const candidate = this.buildSnapshot(nextSource, digest(nextBytes));
      await writeFileAtomically(this.configPath, nextBytes);
      this.accept(candidate);
      return cloneConfiguration(candidate.configuration);
    });
  }

  private accept(snapshot: CatalogSnapshot): void {
    this.snapshot = snapshot;
    this.publish(snapshot.configuration);
  }

  private publishDiagnostic(error: unknown): void {
    const current = this.snapshot;
    if (!current) return;
    const diagnostic = errorMessage(error);
    this.reportError(error);
    const baseline = semanticDiagnostics(current);
    const diagnostics = [...new Set([...baseline, diagnostic])];
    if (arraysEqual(current.configuration.diagnostics, diagnostics)) return;
    const configuration = { ...current.configuration, diagnostics };
    this.snapshot = { ...current, configuration };
    this.publish(configuration);
  }

  private publish(snapshot: AgentModelConfigurationSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneConfiguration(snapshot));
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private current(): CatalogSnapshot {
    if (!this.snapshot) throw new Error("Agent 模型配置尚未初始化");
    return this.snapshot;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertReady(): void {
    this.assertNotDisposed();
    if (!this.initialized) throw new Error("Agent 模型配置尚未初始化");
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Agent 模型配置已停止");
  }
}

function parseModelsFile(
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
function parseDragonHTDevModelSettings(
  value: unknown,
  configPath: string,
  path: string,
): AgentModelSettings {
  const object = requireObject(value, configPath, path);
  const maximumContextTokens = object.maximumContextTokens;
  if (
    typeof maximumContextTokens !== "number" ||
    !Number.isSafeInteger(maximumContextTokens) ||
    maximumContextTokens <= 0 ||
    maximumContextTokens > agentModelMaximumContextTokensLimit
  ) {
    throw configError(
      configPath,
      `${path}.maximumContextTokens 必须是 1 到 ${agentModelMaximumContextTokensLimit} 的整数`,
    );
  }
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
  return { maximumContextTokens, reasoningLevels };
}

function resolveConnectionModels(
  connection: ParsedConnection,
  catalog: readonly AgentProviderCatalogModel[] | undefined,
  configPath: string,
): readonly AgentModelConnectionModel[] {
  const models = connection.models ?? catalog;
  if (!models?.length) {
    throw configError(
      configPath,
      `providers.${connection.id} 必须声明 models，或使用带内建 Catalog 的 Provider Type`,
    );
  }
  const seen = new Set<string>();
  return models.map((model) => {
    if (seen.has(model.id)) {
      throw configError(configPath, `模型重复：${connection.id}/${model.id}`);
    }
    seen.add(model.id);
    return structuredClone(model);
  });
}

function projectConnection(
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
function projectProviderTypes(
  definitions: readonly AgentProviderTypeSnapshot[],
): readonly AgentProviderTypeDescriptor[] {
  return definitions.map((definition) => ({
    id: definition.id,
    displayName: definition.displayName,
    settingsSchema: structuredClone(definition.settingsSchema),
    ...(definition.catalog
      ? { catalog: definition.catalog.map((model) => structuredClone(model)) }
      : {}),
    supportsModelDiscovery: definition.discoverModels !== undefined,
  }));
}

function normalizeDiscoveredModels(
  value: readonly AgentProviderCatalogModel[],
  providerTypeId: string,
): readonly AgentModelConnectionModel[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`AI Provider Type ${providerTypeId} 的模型发现结果必须是数组`);
  }
  const seen = new Set<string>();
  return value.map((model, index) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new TypeError(`AI Provider Type ${providerTypeId} 的模型发现结果 ${index + 1} 无效`);
    }
    const id = requireNonEmptyText(model.id, `模型发现结果 ${index + 1}.id`);
    if (seen.has(id)) {
      throw new TypeError(`AI Provider Type ${providerTypeId} 返回了重复模型：${id}`);
    }
    seen.add(id);
    return {
      id,
      ...(model.displayName
        ? { displayName: requireNonEmptyText(model.displayName, `模型 ${id} displayName`) }
        : {}),
      ...(model.providerOptions
        ? {
            providerOptions: normalizeJsonObject(
              model.providerOptions,
              `模型 ${id} providerOptions`,
            ),
          }
        : {}),
    };
  });
}

function normalizeJsonObject(value: unknown, label: string): JsonObject {
  const normalized = requireJsonValue(value, label);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return normalized;
}

function assertAiSdkProvider(value: object, connectionId: string): AiSdkProvider {
  const record = value as {
    readonly specificationVersion?: unknown;
    readonly languageModel?: unknown;
    readonly embeddingModel?: unknown;
    readonly imageModel?: unknown;
  };
  if (
    (record.specificationVersion !== "v3" && record.specificationVersion !== "v4") ||
    typeof record.languageModel !== "function" ||
    typeof record.embeddingModel !== "function" ||
    typeof record.imageModel !== "function"
  ) {
    throw new TypeError(`连接 ${connectionId} 的 Provider Type 没有返回有效的 AI SDK Provider`);
  }
  return value as AiSdkProvider;
}

function normalizeProviderOptions(
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

const portableReasoningLevels = new Set<string>([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/**
 * 未显式选择时落在离散档位的中间偏左点。六档默认配置会落到 high，
 * 同时保证奇偶数量的自定义档位都有稳定初值。
 */
function resolveSelectedReasoningLevel(
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
 * AI SDK 的通用 reasoning 只接受标准档位。OpenAI 系列与自定义档位继续通过
 * reasoningEffort 传递，OpenAI Compatible 因 Provider 名可配置而使用连接 ID。
 */
function resolveReasoningOptions(
  model: EffectiveModel,
  reasoningLevel: string,
): Pick<ResolvedAgentModel, "providerOptions" | "reasoning"> {
  const configured = resolveProviderOptions(model);
  if (
    model.providerType !== "openai" &&
    model.providerType !== "openai-compatible" &&
    isPortableReasoningLevel(reasoningLevel)
  ) {
    return {
      ...(configured ? { providerOptions: configured } : {}),
      reasoning: reasoningLevel,
    };
  }

  const providerId =
    model.providerType === "openai-compatible" ? model.connectionId : model.providerType;
  return {
    providerOptions: {
      ...configured,
      [providerId]: {
        ...configured?.[providerId],
        reasoningEffort: reasoningLevel,
      },
    },
  };
}

function isPortableReasoningLevel(value: string): value is AgentPortableReasoningLevel {
  return portableReasoningLevels.has(value);
}

/** OpenAI Responses 必须显式关闭服务端存储，以保留可回放的加密推理内容。 */
function resolveProviderOptions(model: EffectiveModel): AgentProviderOptions | undefined {
  const configured = model.providerOptions ?? {};
  if (model.providerType !== "openai") {
    return Object.keys(configured).length > 0 ? structuredClone(configured) : undefined;
  }
  return {
    ...structuredClone(configured),
    openai: {
      ...configured.openai,
      store: false,
    },
  };
}

function normalizeMutations(
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

function requireRevision(value: unknown): string {
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new TypeError("模型供应商配置 revision 无效");
  }
  return value;
}

function requireConnectionId(value: unknown): string {
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

function requireCredentialReference(value: unknown): string {
  const id = requireNonEmptyText(value, "credentialId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new TypeError(`credentialId 格式无效：${id}`);
  }
  return id;
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function requireJsonObject(value: unknown, configPath: string, path: string): JsonObject {
  const normalized = requireJsonValue(value, path);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw configError(configPath, `${path} 必须是对象`);
  }
  return normalized;
}

function requireJsonValue(
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

function requireString(value: unknown, configPath: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw configError(configPath, `${path} 必须是非空字符串`);
  }
  return value.trim();
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumConfigBytes) {
    throw new RangeError(`Agent models.yml 不存在或超过 1 MB：${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumConfigBytes) {
    throw new RangeError(`Agent models.yml 不存在或超过 1 MB：${path}`);
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, configPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configError(configPath, "文件不是有效的 UTF-8 文本");
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function withWriterLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const metadata = await stat(lockPath).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs > writerLockStaleMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(25);
    }
  }
  if (!handle) throw new Error("模型供应商配置正在被另一个 SeaShard 进程写入");
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function createEnvironmentCredentialSource(
  environment: Readonly<Record<string, string | undefined>>,
): AgentCredentialSource {
  return {
    read(credentialId) {
      const value = environment[credentialId];
      return value?.trim() || undefined;
    },
  };
}

function semanticDiagnostics(snapshot: CatalogSnapshot): readonly string[] {
  return snapshot.configuration.connections.flatMap((connection) =>
    connection.diagnostic ? [connection.diagnostic] : [],
  );
}

function cloneConfiguration(
  snapshot: AgentModelConfigurationSnapshot,
): AgentModelConfigurationSnapshot {
  return structuredClone(snapshot);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
