<script setup lang="ts">
import {
  defaultAgentModelMaximumContextTokens,
  defaultAgentModelReasoningLevels,
  type AgentConfiguredModel,
  type AgentConversationMode,
  type AgentModelSelection,
} from "@seashard/contracts";
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
import { computed, nextTick, ref, watch } from "vue";
import "./AgentMessageComposer.css";

const props = defineProps<{
  models: readonly AgentConfiguredModel[];
  selectedModel?: AgentModelSelection;
  selectedMode: AgentConversationMode;
  sending: boolean;
  cancelling: boolean;
  runningInvocationId?: string;
  contextTokensUsed: number;
}>();

const emit = defineEmits<{
  submit: [text: string];
  cancel: [];
  attachment: [];
  "select-model": [model: AgentConfiguredModel];
  "select-mode": [mode: AgentConversationMode];
  "select-reasoning": [reasoningLevel: string];
}>();

const composer = ref("");
const textarea = ref<HTMLTextAreaElement>();
const modelMenuOpen = ref(false);
const modeMenuOpen = ref(false);
const reasoningRail = ref<HTMLElement>();
const dragPosition = ref<number>();
let draggingPointerId: number | undefined;
const reasoningRailRadiusPixels = 10;
const reasoningMagneticRadius = 0.48;
const reasoningMagneticStrength = 0.98;
const contextUsageCircumference = 2 * Math.PI * 10;
const tokenCountFormatter = new Intl.NumberFormat("zh-CN");

const selectedModelRecord = computed(() =>
  props.models.find(
    (model) =>
      model.connectionId === props.selectedModel?.connectionId &&
      model.modelId === props.selectedModel?.modelId,
  ),
);
const selectedModelLabel = computed(() => selectedModelRecord.value?.name ?? "未配置模型");
const selectedModelMaximumContextTokens = computed(
  () =>
    selectedModelRecord.value?.settings?.maximumContextTokens ??
    defaultAgentModelMaximumContextTokens,
);
const selectedModeLabel = computed(() => (props.selectedMode === "agent" ? "Agent" : "Chat"));
const reasoningLevels = computed(
  () => selectedModelRecord.value?.settings?.reasoningLevels ?? defaultAgentModelReasoningLevels,
);
const selectedReasoningIndex = computed(() => {
  const selectedIndex = reasoningLevels.value.indexOf(props.selectedModel?.reasoningLevel ?? "");
  return selectedIndex >= 0 ? selectedIndex : Math.floor((reasoningLevels.value.length - 1) / 2);
});
const visibleReasoningPosition = computed(() => dragPosition.value ?? selectedReasoningIndex.value);
const visibleReasoningIndex = computed(() => Math.round(visibleReasoningPosition.value));
const visibleReasoningLevel = computed(
  () => reasoningLevels.value[visibleReasoningIndex.value] ?? "",
);
const reasoningVisualPosition = computed(() =>
  reasoningPositionCss(visibleReasoningPosition.value),
);
const reasoningDragging = computed(() => dragPosition.value !== undefined);
const canSend = computed(() =>
  Boolean(composer.value.trim() && selectedModelRecord.value && !props.sending),
);
const contextUsagePercentage = computed(() => {
  const maximum = selectedModelMaximumContextTokens.value;
  if (maximum <= 0) return 0;
  return Math.min(100, Math.max(0, (props.contextTokensUsed / maximum) * 100));
});
const contextUsageStrokeOffset = computed(
  () => contextUsageCircumference * (1 - contextUsagePercentage.value / 100),
);
const contextUsageTooltip = computed(
  () =>
    `上下文 ${formatDragonHTDevContextPercentage(contextUsagePercentage.value)}% · 已用 ${tokenCountFormatter.format(
      props.contextTokensUsed,
    )} / ${tokenCountFormatter.format(selectedModelMaximumContextTokens.value)} Token`,
);

watch(
  () => props.sending,
  (sending) => {
    if (!sending) return;
    modelMenuOpen.value = false;
    modeMenuOpen.value = false;
  },
);
watch(
  () =>
    `${props.selectedModel?.connectionId ?? ""}:${props.selectedModel?.modelId ?? ""}:${
      props.selectedModel?.reasoningLevel ?? ""
    }`,
  () => {
    draggingPointerId = undefined;
    dragPosition.value = undefined;
  },
);

function selectModel(model: AgentConfiguredModel): void {
  // 弹层保持打开，模型切换后让下方推理档位立即更新。
  emit("select-model", model);
}

function selectMode(mode: AgentConversationMode): void {
  emit("select-mode", mode);
  modeMenuOpen.value = false;
}
function beginReasoningDrag(event: PointerEvent): void {
  if (reasoningLevels.value.length <= 1) return;
  event.preventDefault();
  draggingPointerId = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  updateReasoningDrag(event);
}

function updateReasoningDrag(event: PointerEvent): void {
  if (event.pointerId !== draggingPointerId) return;
  const element = reasoningRail.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const radius = bounds.height / 2;
  const usableWidth = bounds.width - radius * 2;
  if (usableWidth <= 0) return;
  const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left - radius) / usableWidth));
  const rawPosition = ratio * (reasoningLevels.value.length - 1);
  dragPosition.value = applyReasoningMagnetism(rawPosition);
}

/**
 * 每个档位周围保留一段磁吸区。越靠近锚点，鼠标位移映射越慢；
 * 离开磁吸区后恢复一比一跟随，因此拖动途中仍能连续挣脱当前档位。
 */
function applyReasoningMagnetism(position: number): number {
  const nearest = Math.round(position);
  const distance = position - nearest;
  const normalizedDistance = Math.min(1, Math.abs(distance) / reasoningMagneticRadius);
  const smoothDistance = normalizedDistance * normalizedDistance * (3 - 2 * normalizedDistance);
  const attraction = 1 - smoothDistance;
  return position - distance * reasoningMagneticStrength * attraction;
}

function finishReasoningDrag(event: PointerEvent): void {
  if (event.pointerId !== draggingPointerId) return;
  updateReasoningDrag(event);
  const index = Math.round(dragPosition.value ?? selectedReasoningIndex.value);
  draggingPointerId = undefined;
  if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }
  commitReasoningIndex(index);
  dragPosition.value = undefined;
}

function cancelReasoningDrag(event: PointerEvent): void {
  if (event.pointerId !== draggingPointerId) return;
  draggingPointerId = undefined;
  dragPosition.value = undefined;
}

function handleReasoningKeydown(event: KeyboardEvent): void {
  const lastIndex = reasoningLevels.value.length - 1;
  let nextIndex: number | undefined;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
    nextIndex = Math.max(0, selectedReasoningIndex.value - 1);
  } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
    nextIndex = Math.min(lastIndex, selectedReasoningIndex.value + 1);
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = lastIndex;
  }
  if (nextIndex === undefined) return;
  event.preventDefault();
  commitReasoningIndex(nextIndex);
}

function commitReasoningIndex(index: number): void {
  const reasoningLevel = reasoningLevels.value[index];
  if (reasoningLevel && reasoningLevel !== props.selectedModel?.reasoningLevel) {
    emit("select-reasoning", reasoningLevel);
  }
}

function reasoningPointStyle(index: number): { left: string } {
  return { left: reasoningPositionCss(index) };
}

/**
 * 首尾锚点落在胶囊两端圆弧的圆心上，轨道会在锚点外继续保留一个曲率半径。
 * 中间档位只在两个圆心之间等距分布，拖拽映射使用相同的有效区间。
 */
function reasoningPositionCss(position: number): string {
  const percentage = reasoningPositionPercentage(position);
  const radiusOffset = reasoningRailRadiusPixels * (1 - percentage / 50);
  return `calc(${percentage}% + ${radiusOffset}px)`;
}

function reasoningPositionPercentage(position: number): number {
  const lastIndex = reasoningLevels.value.length - 1;
  return lastIndex <= 0 ? 0 : (position / lastIndex) * 100;
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
  submitMessage();
}

function submitMessage(): void {
  const text = composer.value.trim();
  if (!text || !canSend.value) return;
  modelMenuOpen.value = false;
  modeMenuOpen.value = false;
  emit("submit", text);
}

function handlePrimaryAction(): void {
  if (props.sending) {
    emit("cancel");
    return;
  }
  submitMessage();
}

/** 父页面仅在 Session 已成功创建或消息已成功接收后清空草稿。 */
function clear(): void {
  composer.value = "";
  void nextTick(resizeComposer);
}

function focus(): void {
  void nextTick(() => textarea.value?.focus());
}

function formatDragonHTDevContextPercentage(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

defineExpose({ clear, focus });
</script>

<template>
  <div class="agent-composer-wrap">
    <div class="agent-composer">
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
            @click="emit('attachment')"
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
              aria-haspopup="dialog"
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
            <div
              v-if="modelMenuOpen"
              class="agent-popup agent-model-menu"
              role="dialog"
              aria-label="模型与推理强度"
            >
              <div class="agent-model-options" role="listbox" aria-label="模型">
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

              <section v-if="selectedModelRecord" class="agent-reasoning-control">
                <div class="agent-reasoning-heading">
                  <span>推理强度</span>
                  <strong>{{ visibleReasoningLevel }}</strong>
                </div>
                <div
                  class="agent-reasoning-slider"
                  :class="{ dragging: reasoningDragging }"
                  role="slider"
                  tabindex="0"
                  aria-label="推理强度"
                  aria-orientation="horizontal"
                  :aria-valuemin="0"
                  :aria-valuemax="Math.max(0, reasoningLevels.length - 1)"
                  :aria-valuenow="visibleReasoningIndex"
                  :aria-valuetext="visibleReasoningLevel"
                  :aria-disabled="reasoningLevels.length <= 1"
                  @keydown="handleReasoningKeydown"
                  @pointerdown="beginReasoningDrag"
                  @pointermove="updateReasoningDrag"
                  @pointerup="finishReasoningDrag"
                  @pointercancel="cancelReasoningDrag"
                >
                  <div ref="reasoningRail" class="agent-reasoning-rail" aria-hidden="true">
                    <span
                      class="agent-reasoning-fill"
                      :style="{ width: reasoningVisualPosition }"
                    ></span>
                    <span
                      v-for="(level, index) in reasoningLevels"
                      :key="level"
                      class="agent-reasoning-point"
                      :class="{ active: index <= visibleReasoningPosition }"
                      :style="reasoningPointStyle(index)"
                    ></span>
                    <span
                      class="agent-reasoning-thumb"
                      :style="{ left: reasoningVisualPosition }"
                    ></span>
                  </div>
                </div>
              </section>
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
            @click="handlePrimaryAction"
          >
            <Square v-if="sending" :size="14" :stroke-width="2.2" fill="currentColor" />
            <ArrowUp v-else :size="18" :stroke-width="2.2" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
