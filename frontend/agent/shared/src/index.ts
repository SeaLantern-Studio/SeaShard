import type { AgentSessionService, AgentSessionSummary } from "@seashard/contracts";
import { computed, ref, shallowRef } from "vue";

export interface AgentConversationListItem {
  readonly id: string;
  readonly title: string;
  readonly draft: boolean;
  readonly updatedAt: string;
}

type AgentWorkspaceService = Pick<AgentSessionService, "listSessions">;

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

  createDraft(): string {
    const id = `draft:${crypto.randomUUID()}`;
    this.drafts.value = [
      {
        id,
        title: "新对话",
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
