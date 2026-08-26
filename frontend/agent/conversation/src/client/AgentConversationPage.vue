<script setup lang="ts">
import {
  defaultAgentModelMaximumContextTokens,
  interleaveAgentInvocationContent,
  type AgentConfiguredModel,
  type AgentConversationMode,
  type AgentInvocationService,
  type AgentMessageSnapshot,
  type AgentModelConfigurationClientService,
  type AgentModelSelection,
  type AgentSessionService,
  type AgentSessionSnapshot,
  type AgentToolCallSnapshot,
} from "@seashard/contracts";
import { agentWorkspace } from "@seashard/agent-ui-shared";
import { Cmz_Markdown, Cmz_Toast, useToast } from "cmzya-modern-ui";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  MessageCircle,
  Plus,
  Sparkles,
  Square,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import AgentToolCallCard from "./AgentToolCallCard.vue";
import "./AgentConversationPage.css";

const props = defineProps<{
  sessions: AgentSessionService;
  invocations: AgentInvocationService;
  modelConfiguration: AgentModelConfigurationClientService;
  workspace: typeof agentWorkspace;
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

const toast = useToast();
const composer = ref("");
const textarea = ref<HTMLTextAreaElement>();
const session = shallowRef<AgentSessionSnapshot>();
const models = ref<readonly AgentConfiguredModel[]>([]);
const selectedModel = shallowRef<AgentModelSelection>();
const selectedMode = ref<AgentConversationMode>("chat");
const modelMenuOpen = ref(false);
const modeMenuOpen = ref(false);
const sending = ref(false);
const cancelling = ref(false);
const liveAssistantText = ref("");
const liveToolCalls = shallowRef<readonly AgentToolCallSnapshot[]>([]);
const liveContextTokens = ref<number>();
const runningSessionId = ref<string>();
const runningInvocationId = ref<string>();
let conversationLoad = 0;
let invocationPoll = 0;
let modelConfigurationLoad = 0;
let modelCatalogInitialized = false;
let disposeModelConfigurationChanged: (() => void) | undefined;
const contextUsageCircumference = 2 * Math.PI * 10;
const tokenCountFormatter = new Intl.NumberFormat("zh-CN");

const activeConversationId = computed(() => props.workspace.activeConversationId.value);
const messages = computed(() => session.value?.messages ?? []);
const visibleToolCalls = computed<readonly AgentToolCallSnapshot[]>(() => {
  const calls = new Map<string, AgentToolCallSnapshot>();
  for (const call of session.value?.toolCalls ?? []) calls.set(call.id, call);
  for (const call of liveToolCalls.value) calls.set(call.id, call);
  return [...calls.values()];
});
const conversationEntries = computed<readonly ConversationEntry[]>(() => {
  const entries: ConversationEntry[] = [];
  const assistantTextByInvocation = new Map<string, string>();
  const callsByInvocation = new Map<string, AgentToolCallSnapshot[]>();
  for (const message of messages.value) {
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
  for (const message of messages.value) {
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
      message.invocationId === runningInvocationId.value
        ? liveAssistantText.value
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
      invocationId === runningInvocationId.value
        ? liveAssistantText.value
        : (assistantTextByInvocation.get(invocationId) ?? ""),
      callsByInvocation.get(invocationId) ?? [],
    );
  }
  return entries;
});
const showLiveThinking = computed(() => {
  if (!sending.value || runningSessionId.value !== activeConversationId.value) return false;
  const parts = interleaveAgentInvocationContent(liveAssistantText.value, liveToolCalls.value);
  return parts.length === 0 || parts.at(-1)?.kind === "tool";
});
const selectedModelRecord = computed(() =>
  models.value.find(
    (model) =>
      model.connectionId === selectedModel.value?.connectionId &&
      model.modelId === selectedModel.value?.modelId,
  ),
);
const selectedModelLabel = computed(() => selectedModelRecord.value?.name ?? "未配置模型");
const selectedModelMaximumContextTokens = computed(
  () =>
    selectedModelRecord.value?.settings?.maximumContextTokens ??
    defaultAgentModelMaximumContextTokens,
);
const contextTokensUsed = computed(
  () => liveContextTokens.value ?? session.value?.contextTokens ?? 0,
);
const contextUsagePercentage = computed(() => {
  const maximum = selectedModelMaximumContextTokens.value;
  if (maximum <= 0) return 0;
  return Math.min(100, Math.max(0, (contextTokensUsed.value / maximum) * 100));
});
const contextUsageStrokeOffset = computed(
  () => contextUsageCircumference * (1 - contextUsagePercentage.value / 100),
);
const contextUsageTooltip = computed(
  () =>
    `上下文 ${formatDragonHTDevContextPercentage(contextUsagePercentage.value)}% · 已用 ${tokenCountFormatter.format(
      contextTokensUsed.value,
    )} / ${tokenCountFormatter.format(selectedModelMaximumContextTokens.value)} Token`,
);
const selectedModeLabel = computed(() => (selectedMode.value === "agent" ? "Agent" : "Chat"));
const canSend = computed(() =>
  Boolean(composer.value.trim() && selectedModelRecord.value && !sending.value),
);

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

watch(activeConversationId, (id) => {
  if (id !== runningSessionId.value) {
    liveAssistantText.value = "";
    liveToolCalls.value = [];
    liveContextTokens.value = undefined;
  }
  void loadActiveConversation();
  void nextTick(() => textarea.value?.focus());
});

onMounted(() => {
  // 先订阅再读取初始快照，避免页面挂载期间发生的配置变更落在两个动作之间。
  disposeModelConfigurationChanged = props.modelConfiguration.onConfigurationChanged((snapshot) => {
    modelConfigurationLoad += 1;
    applyModels(snapshot.models);
  });
  void loadModels();
  void loadActiveConversation();
});

onBeforeUnmount(() => {
  conversationLoad += 1;
  invocationPoll += 1;
  modelConfigurationLoad += 1;
  disposeModelConfigurationChanged?.();
});

async function loadModels(): Promise<void> {
  const load = ++modelConfigurationLoad;
  try {
    const snapshot = await props.modelConfiguration.getConfiguration();
    // 变化事件可能先于初始读取返回；旧请求不得覆盖较新的推送快照。
    if (load !== modelConfigurationLoad) return;
    applyModels(snapshot.models);
  } catch (error) {
    if (load !== modelConfigurationLoad) return;
    toast.error({ title: "读取模型配置失败", description: errorMessage(error) });
  }
}

/** 保留仍然可用的选择；供应商被移除时立即切换到当前目录中的首个模型。 */
function applyModels(nextModels: readonly AgentConfiguredModel[]): void {
  models.value = nextModels;
  modelCatalogInitialized = true;
  selectAvailableModel(selectedModel.value);
}

function selectAvailableModel(preferred?: AgentModelSelection): void {
  const available = preferred
    ? models.value.find(
        (model) =>
          model.connectionId === preferred.connectionId && model.modelId === preferred.modelId,
      )
    : undefined;
  const selected = available ?? models.value[0];
  selectedModel.value = selected ? selectionOf(selected) : undefined;
}

async function loadActiveConversation(): Promise<void> {
  const load = ++conversationLoad;
  const id = activeConversationId.value;
  if (!id || props.workspace.isDraft(id)) {
    session.value = undefined;
    return;
  }
  try {
    const snapshot = await props.sessions.getSession(id);
    if (load !== conversationLoad) return;
    session.value = snapshot;
    // Session 可能先于初始模型目录返回；先保留其模型身份，待目录到达后再校验可用性。
    selectedModel.value = { ...snapshot.model };
    if (modelCatalogInitialized) selectAvailableModel(snapshot.model);
  } catch (error) {
    if (load !== conversationLoad) return;
    session.value = undefined;
    toast.error({ title: "读取对话失败", description: errorMessage(error) });
  }
}

function selectionOf(model: AgentConfiguredModel): AgentModelSelection {
  return { connectionId: model.connectionId, modelId: model.modelId };
}

function selectModel(model: AgentConfiguredModel): void {
  selectedModel.value = selectionOf(model);
  modelMenuOpen.value = false;
}

function selectMode(mode: AgentConversationMode): void {
  selectedMode.value = mode;
  modeMenuOpen.value = false;
}

function resizeComposer(): void {
  const element = textarea.value;
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void sendMessage();
}

async function sendMessage(): Promise<void> {
  const text = composer.value.trim();
  const model = selectedModel.value;
  if (!text || !model || sending.value) return;

  sending.value = true;
  modelMenuOpen.value = false;
  modeMenuOpen.value = false;
  const previousId = activeConversationId.value;
  try {
    const reference =
      !previousId || props.workspace.isDraft(previousId)
        ? await props.sessions.startSession({
            initialMessage: { text },
            mode: selectedMode.value,
            model,
          })
        : await props.sessions.sendMessage({
            sessionId: previousId,
            message: { text },
            mode: selectedMode.value,
            model,
          });
    composer.value = "";
    await nextTick(resizeComposer);
    runningSessionId.value = reference.sessionId;
    runningInvocationId.value = reference.invocationId;
    await props.workspace.materializeDraft(previousId, reference.sessionId);
    await loadActiveConversation();
    await pollInvocation(reference.invocationId, reference.sessionId);
  } catch (error) {
    toast.error({ title: "消息发送失败", description: errorMessage(error) });
  } finally {
    sending.value = false;
    cancelling.value = false;
    runningSessionId.value = undefined;
    liveContextTokens.value = undefined;
    runningInvocationId.value = undefined;
    liveAssistantText.value = "";
    liveToolCalls.value = [];
    void nextTick(() => textarea.value?.focus());
  }
}

async function pollInvocation(invocationId: string, sessionId: string): Promise<void> {
  const poll = ++invocationPoll;
  while (poll === invocationPoll) {
    const invocation = await props.invocations.getInvocation(invocationId);
    if (activeConversationId.value === sessionId) {
      liveAssistantText.value = invocation.text;
      liveToolCalls.value = invocation.toolCalls;
      if (invocation.contextTokens !== undefined) {
        liveContextTokens.value = invocation.contextTokens;
      }
    }
    if (invocation.state !== "running") {
      await props.workspace.refresh();
      if (activeConversationId.value === sessionId) await loadActiveConversation();
      if (invocation.state === "failed") {
        toast.error({
          title: "AI 响应失败",
          description: invocation.error ?? "模型调用没有完成。",
        });
      }
      return;
    }
    await delay(120);
  }
}

function showAttachmentPlaceholder(): void {
  toast.info({ title: "附件功能尚未开放" });
}

async function cancelActiveInvocation(): Promise<void> {
  const invocationId = runningInvocationId.value;
  if (!invocationId || cancelling.value) return;
  cancelling.value = true;
  try {
    await props.invocations.cancelInvocation(invocationId);
  } catch (error) {
    cancelling.value = false;
    toast.error({ title: "停止响应失败", description: errorMessage(error) });
  }
}

function formatDragonHTDevContextPercentage(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
</script>

<template>
  <section class="agent-conversation-page" aria-label="Agent 对话">
    <Cmz_Toast position="top-right" />

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
          <article
            v-if="entry.kind === 'message'"
            class="agent-message"
            :class="`is-${entry.role}`"
          >
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

    <div class="agent-composer-wrap">
      <div class="agent-composer" :class="{ focused: composer }">
        <textarea
          ref="textarea"
          v-model="composer"
          class="agent-composer-input"
          rows="1"
          placeholder="给 SeaShard Agent 发送消息"
          aria-label="消息内容"
          @input="resizeComposer"
          @keydown="handleComposerKeydown"
        ></textarea>

        <div class="agent-composer-toolbar">
          <div class="agent-composer-tools">
            <button
              type="button"
              class="agent-tool-button is-icon"
              title="添加附件（暂未开放）"
              aria-label="添加附件（暂未开放）"
              @click="showAttachmentPlaceholder"
            >
              <Plus :size="18" :stroke-width="1.8" />
            </button>

            <div class="agent-popup-anchor">
              <button
                type="button"
                class="agent-tool-button agent-mode-button"
                aria-haspopup="menu"
                :aria-expanded="modeMenuOpen"
                @click="
                  modeMenuOpen = !modeMenuOpen;
                  modelMenuOpen = false;
                "
              >
                <Sparkles v-if="selectedMode === 'agent'" :size="15" :stroke-width="1.8" />
                <MessageCircle v-else :size="15" :stroke-width="1.8" />
                <span>{{ selectedModeLabel }}</span>
                <ChevronDown :size="13" :stroke-width="1.8" />
              </button>
              <div v-if="modeMenuOpen" class="agent-popup agent-mode-menu" role="menu">
                <button
                  type="button"
                  class="agent-popup-option"
                  :class="{ selected: selectedMode === 'chat' }"
                  role="menuitem"
                  @click="selectMode('chat')"
                >
                  <MessageCircle :size="15" />
                  <span>Chat</span>
                  <Check v-if="selectedMode === 'chat'" :size="14" />
                </button>
                <button
                  type="button"
                  class="agent-popup-option"
                  :class="{ selected: selectedMode === 'agent' }"
                  role="menuitem"
                  @click="selectMode('agent')"
                >
                  <Sparkles :size="15" />
                  <span>Agent</span>
                  <Check v-if="selectedMode === 'agent'" :size="14" />
                </button>
              </div>
            </div>
          </div>

          <div class="agent-composer-submit">
            <div class="agent-popup-anchor agent-model-anchor">
              <button
                type="button"
                class="agent-model-button"
                aria-haspopup="listbox"
                :aria-expanded="modelMenuOpen"
                @click="
                  modelMenuOpen = !modelMenuOpen;
                  modeMenuOpen = false;
                "
              >
                <Bot :size="15" :stroke-width="1.8" />
                <span>{{ selectedModelLabel }}</span>
                <ChevronDown :size="13" :stroke-width="1.8" />
              </button>
              <div v-if="modelMenuOpen" class="agent-popup agent-model-menu" role="listbox">
                <div v-if="models.length === 0" class="agent-model-empty">
                  models.yml 中没有模型
                </div>
                <button
                  v-for="model in models"
                  :key="`${model.connectionId}:${model.modelId}`"
                  type="button"
                  class="agent-popup-option agent-model-option"
                  :class="{
                    selected:
                      model.connectionId === selectedModel?.connectionId &&
                      model.modelId === selectedModel?.modelId,
                  }"
                  role="option"
                  :aria-selected="
                    model.connectionId === selectedModel?.connectionId &&
                    model.modelId === selectedModel?.modelId
                  "
                  @click="selectModel(model)"
                >
                  <span class="agent-model-option-copy">
                    <strong>{{ model.name }}</strong>
                    <small>{{ model.connectionId }} · {{ model.modelId }}</small>
                  </span>
                  <Check
                    v-if="
                      model.connectionId === selectedModel?.connectionId &&
                      model.modelId === selectedModel?.modelId
                    "
                    :size="14"
                  />
                </button>
              </div>
            </div>

            <div
              class="agent-context-usage"
              :class="{
                'is-near-limit': contextUsagePercentage >= 90,
                'is-full': contextUsagePercentage >= 100,
              }"
              :aria-label="contextUsageTooltip"
              :data-tooltip="contextUsageTooltip"
              role="img"
              tabindex="0"
            >
              <svg viewBox="0 0 28 28" aria-hidden="true">
                <circle class="agent-context-track" cx="14" cy="14" r="10" />
                <circle
                  class="agent-context-progress"
                  cx="14"
                  cy="14"
                  r="10"
                  :stroke-dasharray="contextUsageCircumference"
                  :stroke-dashoffset="contextUsageStrokeOffset"
                />
              </svg>
            </div>

            <button
              type="button"
              class="agent-send-button"
              :disabled="sending ? !runningInvocationId || cancelling : !canSend"
              :title="sending ? '停止' : '发送'"
              :aria-label="sending ? '停止响应' : '发送消息'"
              @click="sending ? cancelActiveInvocation() : sendMessage()"
            >
              <Square v-if="sending" :size="14" :stroke-width="2.2" fill="currentColor" />
              <ArrowUp v-else :size="18" :stroke-width="2.2" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
