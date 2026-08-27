<script setup lang="ts">
import type { AgentInteractionResponse, AgentPendingInteraction } from "@seashard/contracts";
import { ArrowRight, Check, CircleHelp, ShieldAlert, X } from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import "./AgentInteractionPanel.css";

const props = defineProps<{
  interaction: AgentPendingInteraction;
  responding: boolean;
}>();

const emit = defineEmits<{
  respond: [response: AgentInteractionResponse];
}>();

const customAnswer = ref("");
const customInput = ref<HTMLInputElement>();

const confirmationLevelLabel = computed(() => {
  if (props.interaction.type !== "tool-confirmation") return "";
  return props.interaction.confirmationLevel === 2 ? "二级权限" : "一级权限";
});
const formattedToolInput = computed(() =>
  props.interaction.type === "tool-confirmation"
    ? JSON.stringify(props.interaction.input, null, 2)
    : "",
);

watch(
  () => props.interaction.id,
  () => {
    customAnswer.value = "";
    if (props.interaction.type === "ask") {
      void nextTick(() => customInput.value?.focus());
    }
  },
  { immediate: true },
);

function selectAskOption(optionIndex: number): void {
  const interaction = props.interaction;
  if (interaction.type !== "ask" || props.responding) return;
  emit("respond", {
    interactionId: interaction.id,
    type: "ask-option",
    optionIndex,
  });
}

function submitCustomAnswer(): void {
  const interaction = props.interaction;
  const value = customAnswer.value.trim();
  if (interaction.type !== "ask" || !value || props.responding) return;
  emit("respond", {
    interactionId: interaction.id,
    type: "ask-custom",
    value,
  });
}

function confirmTool(approved: boolean): void {
  const interaction = props.interaction;
  if (interaction.type !== "tool-confirmation" || props.responding) return;
  emit("respond", {
    interactionId: interaction.id,
    type: "tool-confirmation",
    approved,
  });
}
</script>

<template>
  <section
    class="agent-interaction-panel"
    :class="`is-${interaction.type}`"
    :aria-label="interaction.type === 'ask' ? 'Agent 提问' : '工具执行确认'"
  >
    <template v-if="interaction.type === 'ask'">
      <header class="agent-interaction-heading">
        <CircleHelp :size="18" :stroke-width="1.8" aria-hidden="true" />
        <strong>Agent 需要你的回答</strong>
      </header>
      <p class="agent-interaction-question">{{ interaction.question }}</p>
      <div class="agent-ask-options" role="group" aria-label="预设回答">
        <button
          v-for="(option, index) in interaction.options"
          :key="`${index}:${option}`"
          type="button"
          class="agent-ask-option"
          :disabled="responding"
          @click="selectAskOption(index)"
        >
          <span>{{ option }}</span>
          <ArrowRight :size="15" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </div>
      <form class="agent-ask-custom" @submit.prevent="submitCustomAnswer">
        <input
          ref="customInput"
          v-model="customAnswer"
          type="text"
          maxlength="4000"
          placeholder="输入其他回答"
          aria-label="自定义回答"
          :disabled="responding"
        />
        <button
          type="submit"
          :disabled="!customAnswer.trim() || responding"
          aria-label="提交自定义回答"
        >
          <ArrowRight :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
      </form>
    </template>

    <template v-else>
      <header class="agent-interaction-heading">
        <ShieldAlert :size="18" :stroke-width="1.8" aria-hidden="true" />
        <strong>确认执行 {{ interaction.title }}</strong>
        <span class="agent-confirmation-level">{{ confirmationLevelLabel }}</span>
      </header>
      <div class="agent-confirmation-tool">
        <code>{{ interaction.toolName }}</code>
      </div>
      <pre class="agent-confirmation-input"><code>{{ formattedToolInput }}</code></pre>
      <div class="agent-confirmation-actions">
        <button
          type="button"
          class="agent-confirmation-button is-deny"
          :disabled="responding"
          @click="confirmTool(false)"
        >
          <X :size="15" :stroke-width="2" aria-hidden="true" />
          拒绝
        </button>
        <button
          type="button"
          class="agent-confirmation-button is-approve"
          :disabled="responding"
          @click="confirmTool(true)"
        >
          <Check :size="15" :stroke-width="2" aria-hidden="true" />
          允许执行
        </button>
      </div>
    </template>
  </section>
</template>
