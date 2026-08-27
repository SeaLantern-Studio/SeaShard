<script setup lang="ts">
import {
  interleaveAgentInvocationContent,
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
  liveToolCalls: readonly AgentToolCallSnapshot[];
  runningInvocationId?: string;
  streaming: boolean;
}>();

type ConversationEntry =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly role: AgentMessageSnapshot["role"];
      readonly content: string;
    }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly call: AgentToolCallSnapshot;
    };

const visibleToolCalls = computed<readonly AgentToolCallSnapshot[]>(() => {
  const calls = new Map<string, AgentToolCallSnapshot>();
  for (const call of props.toolCalls) calls.set(call.id, call);
  for (const call of props.liveToolCalls) calls.set(call.id, call);
  return [...calls.values()];
});
const conversationEntries = computed<readonly ConversationEntry[]>(() => {
  const entries: ConversationEntry[] = [];
  const assistantTextByInvocation = new Map<string, string>();
  const callsByInvocation = new Map<string, AgentToolCallSnapshot[]>();
  for (const message of props.messages) {
    if (message.role !== "assistant") continue;
    assistantTextByInvocation.set(
      message.invocationId,
      `${assistantTextByInvocation.get(message.invocationId) ?? ""}${message.content}`,
    );
  }
  for (const call of visibleToolCalls.value) {
    const calls = callsByInvocation.get(call.invocationId) ?? [];
    calls.push(call);
    callsByInvocation.set(call.invocationId, calls);
  }

  const representedInvocations = new Set<string>();
  for (const message of props.messages) {
    if (message.role !== "user") continue;
    entries.push({
      kind: "message",
      key: `message:${message.id}`,
      role: "user",
      content: message.content,
    });
    representedInvocations.add(message.invocationId);
    appendAssistantEntries(
      entries,
      message.invocationId,
      message.invocationId === props.runningInvocationId
        ? props.liveAssistantText
        : (assistantTextByInvocation.get(message.invocationId) ?? ""),
      callsByInvocation.get(message.invocationId) ?? [],
    );
  }

  // 损坏 Journal 中的孤立活动仍可局部展示，不能拖垮其余完整会话。
  for (const invocationId of new Set([
    ...assistantTextByInvocation.keys(),
    ...callsByInvocation.keys(),
  ])) {
    if (representedInvocations.has(invocationId)) continue;
    appendAssistantEntries(
      entries,
      invocationId,
      invocationId === props.runningInvocationId
        ? props.liveAssistantText
        : (assistantTextByInvocation.get(invocationId) ?? ""),
      callsByInvocation.get(invocationId) ?? [],
    );
  }
  return entries;
});
const showLiveThinking = computed(() => {
  if (!props.streaming) return false;
  const parts = interleaveAgentInvocationContent(props.liveAssistantText, props.liveToolCalls);
  return parts.length === 0 || parts.at(-1)?.kind === "tool";
});

/** 单次 Invocation 的文字片段和工具卡共用同一偏移恢复规则，流式与历史记录不会分叉。 */
function appendAssistantEntries(
  entries: ConversationEntry[],
  invocationId: string,
  text: string,
  calls: readonly AgentToolCallSnapshot[],
): void {
  for (const part of interleaveAgentInvocationContent(text, calls)) {
    if (part.kind === "tool") {
      entries.push({ kind: "tool", key: `tool:${part.call.id}`, call: part.call });
      continue;
    }
    entries.push({
      kind: "message",
      key: `assistant:${invocationId}:${part.start}:${part.end}`,
      role: "assistant",
      content: part.content,
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
          <div v-if="entry.role === 'assistant'" class="agent-message-avatar" aria-hidden="true">
            <div class="agent-brand-mark"></div>
          </div>
          <div v-if="entry.role === 'user'" class="agent-user-message">
            {{ entry.content }}
          </div>
          <div v-else class="agent-assistant-message">
            <Cmz_Markdown :content="entry.content ?? ''" variant="plain" />
          </div>
        </article>
        <article v-else-if="entry.call" class="agent-message is-assistant is-tool-call">
          <div class="agent-message-avatar" aria-hidden="true">
            <div class="agent-brand-mark"></div>
          </div>
          <AgentToolCallCard :call="entry.call" />
        </article>
      </template>

      <article v-if="showLiveThinking" class="agent-message is-assistant is-live">
        <div class="agent-message-avatar" aria-hidden="true">
          <div class="agent-brand-mark"></div>
        </div>
        <div class="agent-assistant-message">
          <div class="agent-thinking" aria-label="AI 正在回复">
            <span></span><span></span><span></span>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
