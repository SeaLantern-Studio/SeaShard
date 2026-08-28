import type { AgentSessionService, AgentSessionSummary } from "@seashard/contracts";
import { computed, ref, shallowRef } from "vue";

export interface AgentConversationListItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

type AgentWorkspaceService = Pick<
  AgentSessionService,
  "listSessions" | "copySession" | "deleteSession"
>;

/**
 * Agent 对话页与同一 Client Entry 发布的侧栏共享最小状态。
 * Host Session 是列表的唯一事实来源；首次发送前只用临时 ID 表示空白编辑状态。
 */
class AgentWorkspaceState {
  readonly activeConversationId = ref<string>();
  readonly persistedSessions = shallowRef<readonly AgentSessionSummary[]>([]);
  readonly conversations = computed<readonly AgentConversationListItem[]>(() =>
    this.persistedSessions.value.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
    })),
  );

  private service?: AgentWorkspaceService;
  private binding = 0;

  bind(service: AgentWorkspaceService): () => void {
    this.service = service;
    const binding = ++this.binding;
    void this.refresh();
    return () => {
      if (this.binding === binding) this.service = undefined;
    };
  }

  async refresh(): Promise<void> {
    const service = this.service;
    if (!service) return;
    this.persistedSessions.value = await service.listSessions();
  }

  /**
   * Invocation 轮询携带自动标题时只更新对应列表项，避免等待整轮模型与工具执行结束。
   * Host Journal 已先完成落盘，因此这里仅负责 Renderer 的即时投影。
   */
  applySessionTitle(sessionId: string, title: string): void {
    const current = this.persistedSessions.value.find((session) => session.id === sessionId);
    if (!current || current.title === title) return;
    this.persistedSessions.value = this.persistedSessions.value.map((session) =>
      session.id === sessionId ? { ...session, title } : session,
    );
  }

  /** 新建动作只切换到临时空白状态，首条消息发送后才由 Host 创建正式 Session。 */
  createDraft(): string {
    const id = `draft:${crypto.randomUUID()}`;
    this.activeConversationId.value = id;
    return id;
  }

  select(conversationId: string): void {
    this.activeConversationId.value = conversationId;
  }
  async copyConversation(conversationId: string): Promise<string> {
    const conversation = this.conversations.value.find(({ id }) => id === conversationId);
    if (!conversation) throw new Error(`Agent 对话不存在：${conversationId}`);

    const service = this.service;
    if (!service) throw new Error("Agent 对话服务尚未就绪");
    const copy = await service.copySession(conversationId);
    await this.refresh();
    this.activeConversationId.value = copy.id;
    return copy.id;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const conversation = this.conversations.value.find(({ id }) => id === conversationId);
    if (!conversation) throw new Error(`Agent 对话不存在：${conversationId}`);
    const wasActive = this.activeConversationId.value === conversationId;
    const service = this.service;
    if (!service) throw new Error("Agent 对话服务尚未就绪");
    await service.deleteSession(conversationId);
    await this.refresh();

    if (wasActive) this.activeConversationId.value = this.conversations.value[0]?.id;
  }

  isDraft(conversationId: string | undefined): boolean {
    return Boolean(conversationId?.startsWith("draft:"));
  }

  async materializeDraft(draftId: string | undefined, sessionId: string): Promise<void> {
    // 用户等待 startSession 时可能已经切换页面；完成请求不能把界面强行拉回旧草稿。
    if (this.activeConversationId.value === draftId) {
      this.activeConversationId.value = sessionId;
    }
    await this.refresh();
  }
}

export const agentWorkspace = new AgentWorkspaceState();
