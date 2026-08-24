import type { AgentSessionService, AgentSessionSummary } from "@seashard/contracts";
import { computed, ref, shallowRef } from "vue";

export interface AgentConversationListItem {
  readonly id: string;
  readonly title: string;
  readonly draft: boolean;
  readonly updatedAt: string;
}

type AgentWorkspaceService = Pick<
  AgentSessionService,
  "listSessions" | "copySession" | "deleteSession"
>;

/**
 * Agent 对话页与同一 Client Entry 发布的侧栏共享最小状态。
 * Host Session 仍是事实来源；尚未发送首条消息的新对话仅作为 Renderer 草稿存在。
 */
class AgentWorkspaceState {
  readonly activeConversationId = ref<string>();
  readonly persistedSessions = shallowRef<readonly AgentSessionSummary[]>([]);
  readonly drafts = shallowRef<readonly AgentConversationListItem[]>([]);
  readonly conversations = computed<readonly AgentConversationListItem[]>(() => [
    ...this.drafts.value,
    ...this.persistedSessions.value.map((session) => ({
      id: session.id,
      title: session.title,
      draft: false,
      updatedAt: session.updatedAt,
    })),
  ]);

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

  createDraft(title = "新对话"): string {
    const id = `draft:${crypto.randomUUID()}`;
    this.drafts.value = [
      {
        id,
        title,
        draft: true,
        updatedAt: new Date().toISOString(),
      },
      ...this.drafts.value,
    ];
    this.activeConversationId.value = id;
    return id;
  }

  select(conversationId: string): void {
    this.activeConversationId.value = conversationId;
  }
  async copyConversation(conversationId: string): Promise<string> {
    const conversation = this.conversations.value.find(({ id }) => id === conversationId);
    if (!conversation) throw new Error(`Agent 对话不存在：${conversationId}`);
    if (conversation.draft) return this.createDraft(conversation.title);

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

    if (conversation.draft) {
      this.drafts.value = this.drafts.value.filter(({ id }) => id !== conversationId);
    } else {
      const service = this.service;
      if (!service) throw new Error("Agent 对话服务尚未就绪");
      await service.deleteSession(conversationId);
      await this.refresh();
    }

    if (wasActive) this.activeConversationId.value = this.conversations.value[0]?.id;
  }

  isDraft(conversationId: string | undefined): boolean {
    return Boolean(conversationId?.startsWith("draft:"));
  }

  async materializeDraft(draftId: string | undefined, sessionId: string): Promise<void> {
    if (draftId) {
      this.drafts.value = this.drafts.value.filter((draft) => draft.id !== draftId);
    }
    this.activeConversationId.value = sessionId;
    await this.refresh();
  }
}

export const agentWorkspace = new AgentWorkspaceState();
