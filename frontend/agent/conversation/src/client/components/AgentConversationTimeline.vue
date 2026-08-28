<script setup lang="ts">
import {
  interleaveAgentInvocationContent,
  type AgentMessageContentBlock,
  type AgentMessageSnapshot,
  type AgentToolCallSnapshot,
} from "@seashard/contracts";
import { Cmz_Markdown } from "cmzya-modern-ui";
import { computed } from "vue";
import AgentToolCallCard from "../AgentToolCallCard.vue";
import "./AgentConversationTimeline.css";

const props = defineProps<{
  messages: readonly AgentMessageSnapshot[];
  toolCalls: readonly AgentToolCallSnapshot[];
  liveAssistantText: string;
  liveContentBlocks: readonly AgentMessageContentBlock[];
  liveToolCalls: readonly AgentToolCallSnapshot[];
  runningInvocationId?: string;
  streaming: boolean;
}>();

type ConversationEntry =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly invocationId: string;
      readonly role: AgentMessageSnapshot["role"];
      readonly content: string;
      readonly showAvatar?: boolean;
    }
  | {
      readonly kind: "reasoning";
      readonly key: string;
      readonly invocationId: string;
      readonly content: string;
      readonly showAvatar: boolean;
      readonly redacted?: boolean;
    }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly invocationId: string;
      readonly call: AgentToolCallSnapshot;
      readonly showAvatar: boolean;
    };

interface AssistantAvatarPlacement {
  pending: boolean;
}

function takeAssistantAvatar(placement: AssistantAvatarPlacement): boolean {
  if (!placement.pending) return false;
  placement.pending = false;
  return true;
}

function isAssistantEntry(entry: ConversationEntry): boolean {
  return entry.kind !== "message" || entry.role === "assistant";
}

const visibleToolCalls = computed<readonly AgentToolCallSnapshot[]>(() => {
  const calls = new Map<string, AgentToolCallSnapshot>();
  for (const call of props.toolCalls) calls.set(call.id, call);
  for (const call of props.liveToolCalls) calls.set(call.id, call);
  return [...calls.values()];
});
const conversationEntries = computed<readonly ConversationEntry[]>(() => {
  const entries: ConversationEntry[] = [];
  const assistantByInvocation = new Map<string, AgentMessageSnapshot[]>();
  const callsByInvocation = new Map<string, AgentToolCallSnapshot[]>();
  const callsById = new Map<string, AgentToolCallSnapshot>();
  for (const message of props.messages) {
    if (message.role !== "assistant") continue;
    const messages = assistantByInvocation.get(message.invocationId) ?? [];
    messages.push(message);
    assistantByInvocation.set(message.invocationId, messages);
  }
  for (const call of visibleToolCalls.value) {
    callsById.set(call.id, call);
    const calls = callsByInvocation.get(call.invocationId) ?? [];
    calls.push(call);
    callsByInvocation.set(call.invocationId, calls);
  }

  const representedInvocations = new Set<string>();
  for (const message of props.messages) {
    if (message.role !== "user") continue;
    entries.push({
      kind: "message",
      invocationId: message.invocationId,
      key: `message:${message.id}`,
      role: "user",
      content: message.content,
    });
    representedInvocations.add(message.invocationId);
    if (message.invocationId === props.runningInvocationId) {
      appendRichContent(
        entries,
        message.invocationId,
        `live:${message.invocationId}`,
        props.liveContentBlocks.length > 0
          ? props.liveContentBlocks
          : props.liveAssistantText
            ? [{ type: "text", text: props.liveAssistantText }]
            : [],
        callsById,
        { pending: true },
      );
      continue;
    }
    appendStoredInvocation(
      entries,
      message.invocationId,
      assistantByInvocation.get(message.invocationId) ?? [],
      callsByInvocation.get(message.invocationId) ?? [],
      callsById,
    );
  }

  // 损坏 Journal 中的孤立活动仍可局部展示，不能拖垮其余完整会话。
  for (const invocationId of new Set([
    ...assistantByInvocation.keys(),
    ...callsByInvocation.keys(),
  ])) {
    if (representedInvocations.has(invocationId)) continue;
    appendStoredInvocation(
      entries,
      invocationId,
      assistantByInvocation.get(invocationId) ?? [],
      callsByInvocation.get(invocationId) ?? [],
      callsById,
    );
  }
  return entries;
});
const showLiveThinking = computed(() => {
  if (!props.streaming) return false;
  if (props.liveContentBlocks.length === 0) return !props.liveAssistantText;
  const activeBlock = props.liveContentBlocks.at(-1);
  return activeBlock?.type === "reasoning";
});
const showLiveThinkingAvatar = computed(() => {
  const invocationId = props.runningInvocationId;
  if (!showLiveThinking.value || !invocationId) return false;
  return !conversationEntries.value.some(
    (entry) => entry.invocationId === invocationId && isAssistantEntry(entry),
  );
});

/**
 * 推理行已经由时间线统一加粗，模型生成的 Markdown 强调符只会成为可见噪音。
 * 仅展开成对的星号语法，保留算式或普通文本中的独立星号。
 */
function formatReasoningText(content: string): string {
  return content
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1");
}

/** 新记录按内容块精确还原；迁移后的第一版记录继续使用原文本偏移。 */
function appendStoredInvocation(
  entries: ConversationEntry[],
  invocationId: string,
  messages: readonly AgentMessageSnapshot[],
  calls: readonly AgentToolCallSnapshot[],
  callsById: ReadonlyMap<string, AgentToolCallSnapshot>,
): void {
  const rich = messages.some(
    (message) =>
      message.provider ||
      message.usage ||
      message.contentBlocks.some((block) => block.type !== "text"),
  );
  if (!rich) {
    appendLegacyAssistantEntries(
      entries,
      invocationId,
      messages.map(({ content }) => content).join(""),
      calls,
    );
    return;
  }
  const avatarPlacement: AssistantAvatarPlacement = { pending: true };
  for (const message of messages) {
    appendRichContent(
      entries,
      invocationId,
      `message:${message.id}`,
      message.contentBlocks,
      callsById,
      avatarPlacement,
    );
  }
}

function appendRichContent(
  entries: ConversationEntry[],
  invocationId: string,
  keyPrefix: string,
  blocks: readonly AgentMessageContentBlock[],
  callsById: ReadonlyMap<string, AgentToolCallSnapshot>,
  avatarPlacement: AssistantAvatarPlacement,
): void {
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      if (!block.text) return;
      entries.push({
        kind: "message",
        key: `${keyPrefix}:text:${index}`,
        invocationId,
        role: "assistant",
        content: block.text,
        showAvatar: takeAssistantAvatar(avatarPlacement),
      });
      return;
    }
    if (block.type === "reasoning") {
      if (!block.text && !block.redacted) return;
      entries.push({
        kind: "reasoning",
        key: `${keyPrefix}:reasoning:${index}`,
        invocationId,
        content: block.text,
        showAvatar: takeAssistantAvatar(avatarPlacement),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      });
      return;
    }
    const call = callsById.get(block.toolCallId);
    if (call) {
      entries.push({
        kind: "tool",
        key: `tool:${call.id}`,
        invocationId,
        call,
        showAvatar: takeAssistantAvatar(avatarPlacement),
      });
    }
  });
}

/** 第一版 Invocation 的文字片段和工具卡继续共用旧偏移恢复规则。 */
function appendLegacyAssistantEntries(
  entries: ConversationEntry[],
  invocationId: string,
  text: string,
  calls: readonly AgentToolCallSnapshot[],
): void {
  const avatarPlacement: AssistantAvatarPlacement = { pending: true };
  for (const part of interleaveAgentInvocationContent(text, calls)) {
    if (part.kind === "tool") {
      entries.push({
        kind: "tool",
        key: `tool:${part.call.id}`,
        invocationId,
        call: part.call,
        showAvatar: takeAssistantAvatar(avatarPlacement),
      });
      continue;
    }
    entries.push({
      kind: "message",
      key: `assistant:${invocationId}:${part.start}:${part.end}`,
      invocationId,
      role: "assistant",
      content: part.content,
      showAvatar: takeAssistantAvatar(avatarPlacement),
    });
  }
}
</script>

<template>
  <div class="agent-conversation-scroll">
    <div
      v-if="conversationEntries.length === 0 && !showLiveThinking"
      class="agent-conversation-empty"
    >
      <div class="agent-brand-mark" aria-hidden="true"></div>
      <h1>今天想完成什么？</h1>
    </div>

    <div v-else class="agent-message-list" aria-live="polite">
      <template v-for="entry in conversationEntries" :key="entry.key">
        <article v-if="entry.kind === 'message'" class="agent-message" :class="`is-${entry.role}`">
          <div
            v-if="entry.role === 'assistant' && entry.showAvatar"
            class="agent-message-avatar"
            aria-hidden="true"
          >
            <div class="agent-brand-mark"></div>
          </div>
          <div v-if="entry.role === 'user'" class="agent-user-message">
            {{ entry.content }}
          </div>
          <div v-else class="agent-assistant-message">
            <Cmz_Markdown :content="entry.content" variant="plain" />
          </div>
        </article>

        <article
          v-else-if="entry.kind === 'reasoning'"
          class="agent-message is-assistant is-reasoning"
        >
          <div v-if="entry.showAvatar" class="agent-message-avatar" aria-hidden="true">
            <div class="agent-brand-mark"></div>
          </div>
          <div class="agent-reasoning-block">
            {{
              entry.redacted && !entry.content
                ? "供应商已隐藏这段推理内容"
                : formatReasoningText(entry.content)
            }}
          </div>
        </article>

        <article v-else-if="entry.kind === 'tool'" class="agent-message is-assistant is-tool-call">
          <div v-if="entry.showAvatar" class="agent-message-avatar" aria-hidden="true">
            <div class="agent-brand-mark"></div>
          </div>
          <AgentToolCallCard :call="entry.call" />
        </article>
      </template>

      <article v-if="showLiveThinking" class="agent-message is-assistant is-thinking">
        <div v-if="showLiveThinkingAvatar" class="agent-message-avatar" aria-hidden="true">
          <div class="agent-brand-mark"></div>
        </div>
        <div class="agent-thinking" aria-label="AI 正在思考">
          <strong>Thinking</strong>
          <span></span><span></span><span></span>
        </div>
      </article>
    </div>
  </div>
</template>
