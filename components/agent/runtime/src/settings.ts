import type { AgentSettingsSnapshot } from "@seashard/contracts";
import type { JsonValue, PluginStorage } from "@seashard/plugin-sdk";

const agentSettingsStorageKey = "settings";

export const defaultAgentSettings: AgentSettingsSnapshot = {
  automaticConversationSummary: true,
};

export interface AgentSettingsSource {
  get(): Promise<AgentSettingsSnapshot>;
}

/** Agent 设置与模型配置分离保存；模型目录重写不会覆盖产品行为偏好。 */
export class AgentSettingsStore implements AgentSettingsSource {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: PluginStorage) {}

  async get(): Promise<AgentSettingsSnapshot> {
    await this.writeQueue;
    // 多个 Controller 共用 Plugin Storage；每次读取权威文档，避免返回当前进程的旧快照。
    return this.load();
  }

  setAutomaticConversationSummary(enabled: boolean): Promise<AgentSettingsSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new TypeError("automaticConversationSummary 必须是布尔值");
    }
    const task = this.writeQueue.then(async () => {
      const next: AgentSettingsSnapshot = { automaticConversationSummary: enabled };
      await this.storage.put(agentSettingsStorageKey, next as unknown as JsonValue);
      return { ...next };
    });
    this.writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async load(): Promise<AgentSettingsSnapshot> {
    const document = await this.storage.get(agentSettingsStorageKey);
    const value = document?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...defaultAgentSettings };
    }
    const automaticConversationSummary = Reflect.get(value, "automaticConversationSummary");
    return {
      automaticConversationSummary:
        typeof automaticConversationSummary === "boolean"
          ? automaticConversationSummary
          : defaultAgentSettings.automaticConversationSummary,
    };
  }
}
