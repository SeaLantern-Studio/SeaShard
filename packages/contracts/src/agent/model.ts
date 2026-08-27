import { defineServiceContract } from "@seashard/plugin-sdk";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";

/** Agent 模型供应商连接的结构化配置 Contract。 */
export const agentModelConfigurationContract =
  defineServiceContract<AgentModelConfigurationService>("seashard.agent-model-configuration");
/** 模型配置最后有效 Snapshot 变化事件。 */
export const agentModelConfigurationChangedEvent = "seashard.agent-model-configuration.changed";
/** 未显式配置模型能力时，设置页与对话页共同使用的保守默认值。 */
export const agentModelMaximumContextTokensLimit = 100_000_000;
export const agentModelMaximumReasoningLevels = 7;
export const defaultAgentModelMaximumContextTokens = 128_000;
export const defaultAgentModelReasoningLevels = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export interface AgentModelCost {
  /** 每百万输入 Token 的供应商标价。 */
  readonly input: number;
  /** 每百万输出 Token 的供应商标价。 */
  readonly output: number;
  /** 每百万缓存读取 Token 的供应商标价。 */
  readonly cacheRead: number;
  /** 每百万缓存写入 Token 的供应商标价。 */
  readonly cacheWrite: number;
}

/** 每个模型独立保存的能力元数据；推理档位使用供应商实际接收的值。 */
export interface AgentModelSettings {
  readonly maximumContextTokens: number;
  readonly maximumOutputTokens?: number;
  readonly reasoningLevels: readonly string[];
  readonly inputModalities?: readonly ("text" | "image")[];
  readonly api?: string;
  readonly cost?: AgentModelCost;
}

export interface AgentModelSelection {
  readonly connectionId: string;
  readonly modelId: string;
  /** 当前 Invocation 选择的推理档位；档位名称由模型设置声明。 */
  readonly reasoningLevel?: string;
}

export interface AgentConfiguredModel extends AgentModelSelection {
  readonly name: string;
  readonly settings?: AgentModelSettings;
}

export interface AgentModelConnectionModel {
  readonly id: string;
  readonly displayName?: string;
  readonly providerOptions?: JsonObject;
  readonly settings?: AgentModelSettings;
}

/** Renderer 可读取的连接投影不包含凭据正文。 */
export interface AgentModelConnectionConfig {
  readonly id: string;
  readonly displayName?: string;
  readonly providerType: string;
  readonly credentialId?: string;
  readonly credentialConfigured: boolean;
  readonly settings: JsonObject;
  readonly models?: readonly AgentModelConnectionModel[];
  readonly available: boolean;
  readonly diagnostic?: string;
}

/** Provider Type 的只读元数据；工厂和凭据只存在于 Core Host。 */
export interface AgentProviderTypeDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema: JsonObject;
  readonly catalog?: readonly AgentModelConnectionModel[];
  readonly supportsModelDiscovery: boolean;
}

/** revision 对应 models.yml 字节内容；diagnostics 描述未取代最后有效配置的加载故障。 */
export interface AgentModelConfigurationSnapshot {
  readonly revision: string;
  readonly connections: readonly AgentModelConnectionConfig[];
  readonly models: readonly AgentConfiguredModel[];
  readonly providerTypes: readonly AgentProviderTypeDescriptor[];
  readonly diagnostics: readonly string[];
}

export type AgentModelConnectionMutation =
  | {
      readonly op: "set";
      readonly path: readonly string[];
      readonly value: JsonValue;
    }
  | {
      readonly op: "unset";
      readonly path: readonly string[];
    };

/** 管理 Agent 模型连接、凭据引用和可选择模型目录。 */
export interface AgentModelConfigurationService {
  /**
   * 读取最后一次通过校验的模型配置。
   *
   * @returns 当前配置快照及最近一次加载诊断。
   */
  getConfiguration(): Promise<AgentModelConfigurationSnapshot>;
  /**
   * 以乐观并发方式修改指定模型连接。
   *
   * @param input 预期 revision、连接 ID 与有序字段操作。
   * @returns 写入成功后的新配置快照。
   */
  mutateConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
    readonly operations: readonly AgentModelConnectionMutation[];
  }): Promise<AgentModelConfigurationSnapshot>;
  /**
   * 删除一个模型连接及其模型目录引用。
   *
   * @param input 预期 revision 与待删除连接 ID。
   * @returns 删除成功后的新配置快照。
   */
  removeConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /**
   * 用户确认后以空模板替换当前配置，用于从无法结构化编辑的损坏文件恢复。
   *
   * @param input 当前调用方观察到的配置 revision。
   * @returns 重置后的空配置快照。
   */
  resetConfiguration(input: {
    readonly expectedRevision: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /**
   * 使用尚未写入 models.yml 的候选设置和临时凭据查询上游模型目录。
   *
   * @param input Provider 类型、候选设置及可选的临时凭据。
   * @returns 上游当前返回的可配置模型目录。
   */
  discoverModels(input: {
    readonly providerType: string;
    readonly settings: JsonObject;
    readonly credentialId?: string;
    /** 只供本次发现请求使用，不写入 Host Vault。 */
    readonly credentialValue?: string;
  }): Promise<readonly AgentModelConnectionModel[]>;
  /**
   * 将凭据明文写入 Host Vault，任何返回值和事件都不会包含明文。
   *
   * @param input 凭据 ID 与只用于本次写入的明文值。
   * @returns 保持凭据正文脱敏的最新配置快照。
   */
  writeCredential(input: {
    readonly credentialId: string;
    readonly value: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /**
   * 只移除 Host Vault 中的密文，不改写 models.yml 的 credentialId 引用。
   *
   * @param input 待移除的凭据 ID。
   * @returns 更新凭据可用状态后的配置快照。
   */
  removeCredential(input: {
    readonly credentialId: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /** 使用系统默认编辑器打开当前 models.yml。 */
  openConfigurationFile(): Promise<void>;
}
/** Desktop Renderer 使用的模型设置能力；变化订阅由 Preload 转换成可释放监听器。 */
export interface AgentModelConfigurationClientService extends AgentModelConfigurationService {
  onConfigurationChanged(listener: (snapshot: AgentModelConfigurationSnapshot) => void): () => void;
}
