<script setup lang="ts">
import { useClientUiRuntime } from "@seashard/ui-runtime";
import { onErrorCaptured, ref, watch } from "vue";

const props = defineProps<{
  runtimeId?: string;
}>();

const runtime = useClientUiRuntime();
const failure = ref<string>();

watch(
  () => props.runtimeId,
  (runtimeId) => {
    failure.value = undefined;
    if (runtimeId) runtime.clearRenderFailure(runtimeId);
  },
);

onErrorCaptured((error) => {
  failure.value = error instanceof Error ? error.message : String(error);
  if (props.runtimeId) runtime.reportRenderFailure(props.runtimeId, error);
  return false;
});
</script>

<template>
  <section v-if="failure" class="entry-failure" role="alert">
    <p>UI ENTRY FAILED</p>
    <h2>此页面无法继续渲染</h2>
    <code>{{ failure }}</code>
  </section>
  <slot v-else />
</template>
