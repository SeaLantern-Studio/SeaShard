import type {
  AgentConfiguredModel,
  AgentModelConfigurationSnapshot,
  AgentModelConnectionConfig,
  AgentModelConnectionModel,
  AgentModelConnectionMutation,
  AgentModelSelection,
} from "@seashard/contracts";
import type { JsonObject } from "@seashard/plugin-sdk";
import {
  projectAgentPiModelSettings,
  resolveAgentPiModel,
  resolveAgentPiThinkingLevel,
} from "./provider-types";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createEnvironmentCredentialSource,
  emptyModelsTemplate,
  errorMessage,
  normalizeMutations,
  parseModelsFile,
  requireConnectionId,
  requireCredentialReference,
  requireNonEmptyText,
  requireRevision,
  type ParsedYamlDocument,
} from "./model-config/document";
import {
  arraysEqual,
  assertAgentPiProviderConnection,
  cloneConfiguration,
  clonePiModel,
  normalizeDiscoveredModels,
  normalizeJsonObject,
  normalizeProviderOptions,
  projectConnection,
  projectProviderTypes,
  resolveConnectionModels,
  resolveRequestOptions,
  resolveSelectedReasoningLevel,
  semanticDiagnostics,
} from "./model-config/projection";
import {
  decodeUtf8,
  digest,
  isAlreadyExists,
  maximumConfigBytes,
  readBoundedFile,
  withWriterLock,
  writeFileAtomically,
} from "./model-config/storage";
import type {
  AgentCredentialSource,
  AgentProviderTypeSource,
  CatalogSnapshot,
  EffectiveModel,
  ResolvedAgentModel,
} from "./model-config/types";

export const agentModelsFileName = "models.yml";

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
 * 该类把文件、Provider Type 与凭据一次性投影成不可变连接快照。任何候选投影失败
 * 都会保留上一份可调用快照；运行中的 Invocation 已持有连接级 Models 与 Model，
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
      ({
        providerType: _providerType,
        providerOptions: _options,
        connection: _connection,
        piModel: _piModel,
        ...model
      }) => ({ ...model }),
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
    const reasoning = resolveAgentPiThinkingLevel(model.piModel, reasoningLevel);
    const requestOptions = resolveRequestOptions(model);
    return {
      selection: {
        connectionId: model.connectionId,
        modelId: model.modelId,
        reasoningLevel,
      },
      models: model.connection.models,
      model: clonePiModel(model.piModel),
      ...(requestOptions ? { requestOptions } : {}),
      ...(reasoning ? { reasoning } : {}),
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
      return normalizeDiscoveredModels(models, providerTypeId, this.configPath);
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
      providerTypes: projectProviderTypes(
        this.providerTypes.snapshot().definitions,
        this.configPath,
      ),
      diagnostics: [errorMessage(error)],
    };
    return {
      revision,
      source,
      models: [],
      configuration,
      loadedAt: new Date().toISOString(),
    };
  }

  private buildSnapshot(source: string, revision: string): CatalogSnapshot {
    const connections = parseModelsFile(source, this.configPath).connections;
    const providerTypeSnapshot = this.providerTypes.snapshot();
    const models: EffectiveModel[] = [];
    const projectedConnections: AgentModelConnectionConfig[] = [];
    const diagnostics: string[] = [];

    for (const connection of connections) {
      const credential = connection.credentialId
        ? this.credentials.read(connection.credentialId)
        : undefined;
      // 显式 credentialId 缺失时不创建连接，避免驱动悄悄回退到进程环境中的同名变量。
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
      const piConnection = assertAgentPiProviderConnection(
        providerType.create({
          connectionId: connection.id,
          settings: structuredClone(connection.settings),
          ...(credential ? { apiKey: credential } : {}),
        }),
        connection.id,
      );
      projectedConnections.push(projectConnection(connection, Boolean(credential), true));
      for (const configured of configuredModels) {
        const piModel = resolveAgentPiModel(piConnection, configured.id, configured.settings);
        // 公共模型投影必须沿用用户配置顺序；pi-ai 的内部槽位只负责协议映射，
        // 若反向投影会把 ultra 等供应商值移动到列表首位。
        const projectedSettings = {
          ...projectAgentPiModelSettings(piModel),
          ...(configured.settings
            ? { reasoningLevels: [...configured.settings.reasoningLevels] }
            : {}),
        };
        models.push({
          connectionId: connection.id,
          modelId: configured.id,
          name: configured.displayName ?? piModel.name,
          settings: projectedSettings,
          providerType: connection.providerType,
          connection: piConnection,
          piModel,
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

    const configuration: AgentModelConfigurationSnapshot = {
      revision,
      connections: projectedConnections,
      models: models.map(
        ({
          providerType: _providerType,
          providerOptions: _options,
          connection: _connection,
          piModel: _piModel,
          ...model
        }) => ({ ...model }),
      ),
      providerTypes: projectProviderTypes(providerTypeSnapshot.definitions, this.configPath),
      diagnostics,
    };
    return {
      revision,
      source,
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
