<script setup lang="ts">
import type { AgentToolCallSnapshot } from "@seashard/contracts";
import type { AgentActivityPresentationField } from "@seashard/plugin-sdk";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  OctagonX,
  Wrench,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import "./AgentToolCallCard.css";

const props = defineProps<{
  call: AgentToolCallSnapshot;
}>();

const expanded = ref(false);
const statusText = computed(() => {
  switch (props.call.state) {
    case "running":
      return "正在调用";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "failed":
      return "调用失败";
  }
});
const requestSummary = computed(() =>
  formatPresentationFields(props.call.presentation.requestPayload),
);
const resultSummary = computed(() =>
  formatPresentationFields(props.call.presentation.resultPayload),
);
const hasDetails = computed(
  () => props.call.input !== null || props.call.output !== undefined || Boolean(props.call.error),
);

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatPresentationFields(
  fields: readonly AgentActivityPresentationField[] | undefined,
): string {
  return (fields ?? [])
    .map(({ label, value, unit }) => `${label ? `${label}：` : ""}${value}${unit ?? ""}`)
    .join("，");
}
</script>

<template>
  <div class="agent-tool-call-card" :class="`is-${call.state}`">
    <button
      type="button"
      class="agent-tool-call-summary"
      :disabled="!hasDetails"
      :aria-expanded="hasDetails ? expanded : undefined"
      @click="expanded = !expanded"
    >
      <span class="agent-tool-call-glyph" aria-hidden="true">
        <Wrench :size="15" :stroke-width="1.8" />
      </span>
      <span class="agent-tool-call-heading">
        <span class="agent-tool-call-title">{{ call.presentation.title }}</span>
        <span v-if="requestSummary" class="agent-tool-call-request">：{{ requestSummary }}</span>
      </span>
      <span class="agent-tool-call-state">
        <LoaderCircle v-if="call.state === 'running'" class="is-spinning" :size="14" />
        <CheckCircle2 v-else-if="call.state === 'completed'" :size="14" />
        <OctagonX v-else-if="call.state === 'cancelled'" :size="14" />
        <CircleAlert v-else :size="14" />
        <span>{{ resultSummary || statusText }}</span>
      </span>
      <ChevronDown
        v-if="hasDetails"
        class="agent-tool-call-chevron"
        :class="{ expanded }"
        :size="14"
        aria-hidden="true"
      />
    </button>

    <div v-if="expanded && hasDetails" class="agent-tool-call-details">
      <section>
        <strong>输入</strong>
        <pre>{{ formatJson(call.input) }}</pre>
      </section>
      <section v-if="call.output !== undefined">
        <strong>结果</strong>
        <pre>{{ formatJson(call.output) }}</pre>
      </section>
      <section v-if="call.error">
        <strong>错误</strong>
        <pre>{{ call.error }}</pre>
      </section>
    </div>
  </div>
</template>
