<script setup lang="ts">
import type {
  AgentConfiguredModel,
  AgentInvocationService,
  AgentModelSelection,
  AgentSessionService,
  AgentSessionSnapshot,
} from "@seashard/contracts";
import { agentWorkspace } from "@seashard/agent-ui-shared";
import { Cmz_Markdown, Cmz_Toast, useToast } from "cmzya-modern-ui";
import { ArrowUp, Bot, Check, ChevronDown, MessageCircle, Plus, Sparkles } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import "./AgentConversationPage.css";

const props = defineProps<{
  sessions: AgentSessionService;
  invocations: AgentInvocationService;
  workspace: typeof agentWorkspace;
}>();

const toast = useToast();
const composer = ref("");
const textarea = ref<HTMLTextAreaElement>();
const session = ref<AgentSessionSnapshot>();
const models = ref<readonly AgentConfiguredModel[]>([]);
const selectedModel = shallowRef<AgentModelSelection>();
const modelMenuOpen = ref(false);
const modeMenuOpen = ref(false);
const sending = ref(false);
const liveAssistantText = ref("");
const runningSessionId = ref<string>();
let conversationLoad = 0;
let invocationPoll = 0;

const activeConversationId = computed(() => props.workspace.activeConversationId.value);
const messages = computed(() => session.value?.messages ?? []);
const selectedModelRecord = computed(() =>
  models.value.find(
    (model) =>
      model.connectionId === selectedModel.value?.connectionId &&
      model.modelId === selectedModel.value?.modelId,
  ),
);
const selectedModelLabel = computed(() => selectedModelRecord.value?.name ?? "未配置模型");
const canSend = computed(() =>
  Boolean(composer.value.trim() && selectedModel.value && !sending.value),
);

watch(activeConversationId, () => {
  void loadActiveConversation();
  void nextTick(() => textarea.value?.focus());
});

onMounted(() => {
  void loadModels();
  void loadActiveConversation();
});

onBeforeUnmount(() => {
  conversationLoad += 1;
  invocationPoll += 1;
});

async function loadModels(): Promise<void> {
  try {
    models.value = await props.sessions.listModels();
    if (!selectedModel.value && models.value[0]) {
      selectedModel.value = selectionOf(models.value[0]);
    }
  } catch (error) {
    toast.error({ title: "读取模型配置失败", description: errorMessage(error) });
  }
}

async function loadActiveConversation(): Promise<void> {
  const load = ++conversationLoad;
  const id = activeConversationId.value;
  liveAssistantText.value = "";
  runningSessionId.value = undefined;
  if (!id || props.workspace.isDraft(id)) {
    session.value = undefined;
    return;
  }
  try {
    const snapshot = await props.sessions.getSession(id);
    if (load !== conversationLoad) return;
    session.value = snapshot;
    selectedModel.value = { ...snapshot.model };
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
        ? await props.sessions.startSession({ initialMessage: { text }, model })
        : await props.sessions.sendMessage({
            sessionId: previousId,
            message: { text },
            model,
          });
    composer.value = "";
    await nextTick(resizeComposer);
    await props.workspace.materializeDraft(previousId, reference.sessionId);
    runningSessionId.value = reference.sessionId;
    await loadActiveConversation();
    await pollInvocation(reference.invocationId, reference.sessionId);
  } catch (error) {
    toast.error({ title: "消息发送失败", description: errorMessage(error) });
  } finally {
    sending.value = false;
    runningSessionId.value = undefined;
    liveAssistantText.value = "";
    void nextTick(() => textarea.value?.focus());
  }
}

async function pollInvocation(invocationId: string, sessionId: string): Promise<void> {
  const poll = ++invocationPoll;
  while (poll === invocationPoll) {
    const invocation = await props.invocations.getInvocation(invocationId);
    if (activeConversationId.value === sessionId) liveAssistantText.value = invocation.text;
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

function showAgentPlaceholder(): void {
  modeMenuOpen.value = false;
  toast.info({ title: "Agent 模式尚未开放" });
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
      <div v-if="messages.length === 0 && !liveAssistantText" class="agent-conversation-empty">
        <div class="agent-brand-mark" aria-hidden="true"></div>
        <h1>今天想完成什么？</h1>
      </div>

      <div v-else class="agent-message-list" aria-live="polite">
        <article
          v-for="message in messages"
          :key="message.id"
          class="agent-message"
          :class="`is-${message.role}`"
        >
          <div v-if="message.role === 'assistant'" class="agent-message-avatar" aria-hidden="true">
            <div class="agent-brand-mark"></div>
          </div>
          <div v-if="message.role === 'user'" class="agent-user-message">
            {{ message.content }}
          </div>
          <div v-else class="agent-assistant-message">
            <Cmz_Markdown :content="message.content" variant="plain" />
          </div>
        </article>

        <article
          v-if="sending && runningSessionId === activeConversationId"
          class="agent-message is-assistant is-live"
        >
          <div class="agent-message-avatar" aria-hidden="true">
            <div class="agent-brand-mark"></div>
          </div>
          <div class="agent-assistant-message">
            <Cmz_Markdown v-if="liveAssistantText" :content="liveAssistantText" variant="plain" />
            <div v-else class="agent-thinking" aria-label="AI 正在回复">
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
                <MessageCircle :size="15" :stroke-width="1.8" />
                <span>Chat</span>
                <ChevronDown :size="13" :stroke-width="1.8" />
              </button>
              <div v-if="modeMenuOpen" class="agent-popup agent-mode-menu" role="menu">
                <button type="button" class="agent-popup-option selected" role="menuitem">
                  <MessageCircle :size="15" />
                  <span>Chat</span>
                  <Check :size="14" />
                </button>
                <button
                  type="button"
                  class="agent-popup-option"
                  role="menuitem"
                  @click="showAgentPlaceholder"
                >
                  <Sparkles :size="15" />
                  <span>Agent</span>
                  <small>即将支持</small>
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

            <button
              type="button"
              class="agent-send-button"
              :disabled="!canSend"
              title="发送"
              aria-label="发送消息"
              @click="sendMessage"
            >
              <ArrowUp :size="18" :stroke-width="2.2" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
