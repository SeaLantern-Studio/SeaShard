<script setup lang="ts">
import {
  defaultAgentModelReasoningLevels,
  type AgentConfiguredModel,
  type AgentConversationMode,
  type AgentInvocationService,
  type AgentInteractionResponse,
  type AgentPendingInteraction,
  type AgentPermissionMode,
  type AgentMessageContentBlock,
  type AgentModelConfigurationClientService,
  type AgentModelSelection,
  type AgentSessionService,
  type AgentSessionSnapshot,
  type AgentToolCallSnapshot,
  type AgentTodoSnapshot,
} from "@seashard/contracts";
import { agentWorkspace } from "@seashard/agent-ui-shared";
import { Cmz_Toast, useToast } from "cmzya-modern-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import AgentConversationTimeline from "./components/AgentConversationTimeline.vue";
import AgentMessageComposer from "./components/AgentMessageComposer.vue";
import "./AgentConversationPage.css";

const props = defineProps<{
  sessions: AgentSessionService;
  invocations: AgentInvocationService;
  modelConfiguration: AgentModelConfigurationClientService;
  workspace: typeof agentWorkspace;
}>();

type AgentMessageComposerHandle = {
  clear(): void;
  focus(): void;
};

const toast = useToast();
const composerComponent = ref<AgentMessageComposerHandle>();
const session = shallowRef<AgentSessionSnapshot>();
const models = ref<readonly AgentConfiguredModel[]>([]);
const selectedModel = shallowRef<AgentModelSelection>();
const selectedMode = ref<AgentConversationMode>("agent");
const selectedPermissionMode = ref<AgentPermissionMode>("read-only");
const reasoningLevelByModel = new Map<string, string>();
const sending = ref(false);
const respondingToInteraction = ref(false);
const cancelling = ref(false);
const liveAssistantText = ref("");
const liveContentBlocks = shallowRef<readonly AgentMessageContentBlock[]>([]);
const liveToolCalls = shallowRef<readonly AgentToolCallSnapshot[]>([]);
const liveContextTokens = ref<number>();
const runningSessionId = ref<string>();
const runningInvocationId = ref<string>();
const liveInteraction = shallowRef<AgentPendingInteraction>();
const liveTodo = shallowRef<AgentTodoSnapshot>();
let conversationLoad = 0;
let invocationPoll = 0;
let modelConfigurationLoad = 0;
let modelCatalogInitialized = false;
let disposeModelConfigurationChanged: (() => void) | undefined;

const activeConversationId = computed(() => props.workspace.activeConversationId.value);

watch(activeConversationId, (id) => {
  if (id !== runningSessionId.value) {
    liveAssistantText.value = "";
    liveContentBlocks.value = [];
    liveToolCalls.value = [];
    liveInteraction.value = undefined;
    liveTodo.value = undefined;
    liveContextTokens.value = undefined;
  }
  void loadActiveConversation();
  void nextTick(() => composerComponent.value?.focus());
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
  selectedModel.value = selected
    ? selectionOf(selected, available ? preferred?.reasoningLevel : undefined)
    : undefined;
}

async function loadActiveConversation(): Promise<void> {
  const load = ++conversationLoad;
  const id = activeConversationId.value;
  if (!id || props.workspace.isDraft(id)) {
    session.value = undefined;
    liveTodo.value = undefined;
    return;
  }
  try {
    const snapshot = await props.sessions.getSession(id);
    if (load !== conversationLoad) return;
    session.value = snapshot;
    liveTodo.value = snapshot.todo;
    // Session 可能先于初始模型目录返回；先保留其模型身份，待目录到达后再校验可用性。
    selectedModel.value = { ...snapshot.model };
    if (modelCatalogInitialized) selectAvailableModel(snapshot.model);
  } catch (error) {
    if (load !== conversationLoad) return;
    session.value = undefined;
    toast.error({ title: "读取对话失败", description: errorMessage(error) });
  }
}

function selectionOf(
  model: AgentConfiguredModel,
  preferredReasoningLevel?: string,
): AgentModelSelection {
  const levels = model.settings?.reasoningLevels ?? defaultAgentModelReasoningLevels;
  const remembered = preferredReasoningLevel ?? reasoningLevelByModel.get(modelSelectionKey(model));
  const reasoningLevel =
    remembered && levels.includes(remembered)
      ? remembered
      : levels[Math.floor((levels.length - 1) / 2)]!;
  reasoningLevelByModel.set(modelSelectionKey(model), reasoningLevel);
  return { connectionId: model.connectionId, modelId: model.modelId, reasoningLevel };
}

function selectModel(model: AgentConfiguredModel): void {
  selectedModel.value = selectionOf(model);
}

function selectReasoningLevel(reasoningLevel: string): void {
  const model = models.value.find(
    (candidate) =>
      candidate.connectionId === selectedModel.value?.connectionId &&
      candidate.modelId === selectedModel.value?.modelId,
  );
  if (!model) return;
  selectedModel.value = selectionOf(model, reasoningLevel);
}

function modelSelectionKey(model: AgentModelSelection): string {
  return `${model.connectionId}:${model.modelId}`;
}

function selectMode(mode: AgentConversationMode): void {
  selectedMode.value = mode;
}

async function sendMessage(text: string): Promise<void> {
  const message = text.trim();
  const model = selectedModel.value;
  if (!message || !model || sending.value) return;

  sending.value = true;
  const previousId = activeConversationId.value;
  try {
    const reference =
      !previousId || props.workspace.isDraft(previousId)
        ? await props.sessions.startSession({
            initialMessage: { text: message },
            mode: selectedMode.value,
            permissionMode: selectedPermissionMode.value,
            model,
          })
        : await props.sessions.sendMessage({
            sessionId: previousId,
            message: { text: message },
            mode: selectedMode.value,
            permissionMode: selectedPermissionMode.value,
            model,
          });
    composerComponent.value?.clear();
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
    liveInteraction.value = undefined;
    runningInvocationId.value = undefined;
    liveAssistantText.value = "";
    liveContentBlocks.value = [];
    liveToolCalls.value = [];
    void nextTick(() => composerComponent.value?.focus());
  }
}

async function pollInvocation(invocationId: string, sessionId: string): Promise<void> {
  const poll = ++invocationPoll;
  while (poll === invocationPoll) {
    const invocation = await props.invocations.getInvocation(invocationId);
    if (invocation.sessionTitle) {
      props.workspace.applySessionTitle(sessionId, invocation.sessionTitle);
    }
    if (activeConversationId.value === sessionId) {
      liveAssistantText.value = invocation.text;
      liveContentBlocks.value = invocation.contentBlocks;
      liveToolCalls.value = invocation.toolCalls;
      liveInteraction.value = invocation.interaction;
      if (invocation.todo) liveTodo.value = invocation.todo;
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

async function respondToInteraction(response: AgentInteractionResponse): Promise<void> {
  const invocationId = runningInvocationId.value;
  const interaction = liveInteraction.value;
  if (
    !invocationId ||
    !interaction ||
    interaction.id !== response.interactionId ||
    respondingToInteraction.value
  ) {
    return;
  }
  respondingToInteraction.value = true;
  try {
    await props.invocations.respondToInteraction({ invocationId, response });
    liveInteraction.value = undefined;
  } catch (error) {
    toast.error({ title: "提交交互失败", description: errorMessage(error) });
  } finally {
    respondingToInteraction.value = false;
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

    <AgentConversationTimeline
      :messages="session?.messages ?? []"
      :tool-calls="session?.toolCalls ?? []"
      :live-assistant-text="liveAssistantText"
      :live-content-blocks="liveContentBlocks"
      :live-tool-calls="liveToolCalls"
      :running-invocation-id="runningInvocationId"
      :streaming="sending && runningSessionId === activeConversationId"
    />

    <AgentMessageComposer
      ref="composerComponent"
      :models="models"
      :selected-model="selectedModel"
      :selected-mode="selectedMode"
      :selected-permission-mode="selectedPermissionMode"
      :sending="sending"
      :cancelling="cancelling"
      :interaction="liveInteraction"
      :responding-to-interaction="respondingToInteraction"
      :todo="liveTodo"
      :running-invocation-id="runningInvocationId"
      :context-tokens-used="liveContextTokens ?? session?.contextTokens ?? 0"
      @attachment="showAttachmentPlaceholder"
      @cancel="cancelActiveInvocation"
      @select-model="selectModel"
      @select-mode="selectMode"
      @select-reasoning="selectReasoningLevel"
      @select-permission-mode="selectedPermissionMode = $event"
      @respond-interaction="respondToInteraction"
      @submit="sendMessage"
    />
  </section>
</template>
