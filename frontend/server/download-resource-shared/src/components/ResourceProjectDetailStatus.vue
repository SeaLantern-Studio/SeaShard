<script setup lang="ts">
const props = defineProps<{
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  retry: [];
}>();
</script>

<template>
  <div v-if="props.loading" class="mod-detail-loading" role="status">
    <span class="mod-loading-spinner" />
    正在加载可下载版本
  </div>
  <div v-else-if="props.error" class="mod-result-state mod-detail-state" role="alert">
    <strong>无法加载可下载版本</strong>
    <span>{{ props.error }}</span>
    <button type="button" @click="emit('retry')">重新加载</button>
  </div>
</template>

<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceFeedback.css"></style>
<style scoped src="./ResourceProjectDetailStatus.css"></style>
