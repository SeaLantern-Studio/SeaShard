import { defineServiceContract } from "@seashard/plugin-sdk";

/** Agent Runtime 发布的全局行为设置 Contract。 */
export const agentSettingsContract =
  defineServiceContract<AgentSettingsService>("seashard.agent-settings");

/** 可跨 Host/Client 边界传输的 Agent 设置快照。 */
export interface AgentSettingsSnapshot {
  readonly automaticConversationSummary: boolean;
}

/** Renderer 只获得 Agent 行为设置读写能力，不接触插件存储。 */
export interface AgentSettingsService {
  /**
   * 读取当前 Agent 全局设置。
   *
   * @returns 当前自动化行为设置。
   */
  get(): Promise<AgentSettingsSnapshot>;
  /**
   * 开启或关闭自动对话标题总结。
   *
   * @param enabled 是否在首轮与后续周期边界生成对话标题。
   * @returns 更新后的 Agent 设置快照。
   */
  setAutomaticConversationSummary(enabled: boolean): Promise<AgentSettingsSnapshot>;
}
