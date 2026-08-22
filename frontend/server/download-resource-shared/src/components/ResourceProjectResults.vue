<script setup lang="ts">
import type { ServerModProject } from "@seashard/contracts";
import type { Component } from "vue";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ResourceProjectRow from "./ResourceProjectRow.vue";

const props = defineProps<{
  resourceLabel: string;
  resultSummary: string;
  projects: readonly ServerModProject[];
  initialLoading: boolean;
  loadingMore: boolean;
  searchError: string;
  hasMore: boolean;
  sourceWarning: string;
  resourceIcon: Component;
  primaryName: (project: ServerModProject) => string;
  originalName: (project: ServerModProject) => string | undefined;
  contentTags: (project: ServerModProject) => readonly string[];
  categoryTags: (project: ServerModProject) => readonly string[];
  sourceLabel: (source: ServerModProject["source"]) => string;
  versionRange: (project: ServerModProject) => string;
  relativeTime: (value: string) => string;
  downloadCount: (value: number) => string;
  iconFailed: (project: ServerModProject) => boolean;
}>();

const emit = defineEmits<{
  "open-project": [project: ServerModProject];
  "icon-error": [projectId: string];
  "retry-search": [];
  "retry-next-page": [];
  "load-more": [];
}>();

const loadSentinel = ref<HTMLElement>();
let observer: IntersectionObserver | undefined;

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) emit("load-more");
    },
    { rootMargin: "240px 0px" },
  );
  if (loadSentinel.value) observer.observe(loadSentinel.value);
  void ensureViewportFilled();
});

watch(loadSentinel, (next, previous) => {
  if (previous) observer?.unobserve(previous);
  if (next) observer?.observe(next);
});
watch(
  () => [props.projects.length, props.initialLoading, props.loadingMore, props.hasMore],
  () => void ensureViewportFilled(),
);

onBeforeUnmount(() => {
  observer?.disconnect();
});

async function ensureViewportFilled(): Promise<void> {
  await nextTick();
  const sentinel = loadSentinel.value;
  if (!sentinel || !props.hasMore || props.initialLoading || props.loadingMore) return;
  if (sentinel.getBoundingClientRect().top <= window.innerHeight + 240) emit("load-more");
}
</script>

<template>
  <div class="mod-results-heading">
    <strong>{{ props.resultSummary }}</strong>
    <span v-if="props.projects.length > 0"
      >已加载 {{ props.projects.length.toLocaleString("zh-CN") }} 个</span
    >
  </div>
  <div v-if="props.sourceWarning" class="mod-inline-error" role="status">
    <span>部分来源暂时不可用：{{ props.sourceWarning }}</span>
    <button type="button" @click="emit('retry-search')">重试</button>
  </div>

  <div
    v-if="props.initialLoading"
    class="mod-project-list"
    :aria-label="`正在加载${props.resourceLabel}`"
  >
    <div v-for="index in 6" :key="index" class="mod-project-row mod-project-row-loading">
      <span class="mod-project-icon-placeholder" />
      <span class="mod-project-copy-placeholder">
        <i />
        <i />
        <i />
      </span>
    </div>
  </div>

  <div
    v-else-if="props.searchError && props.projects.length === 0"
    class="mod-result-state"
    role="alert"
  >
    <strong>无法加载{{ props.resourceLabel }}</strong>
    <span>{{ props.searchError }}</span>
    <button type="button" @click="emit('retry-search')">重新搜索</button>
  </div>

  <div v-else-if="props.projects.length === 0" class="mod-result-state">
    <strong>没有找到符合条件的{{ props.resourceLabel }}</strong>
    <span>尝试减少筛选条件或更换搜索关键词。</span>
  </div>

  <div v-else class="mod-project-list" aria-live="polite">
    <ResourceProjectRow
      v-for="project in props.projects"
      :key="`${project.source}:${project.id}`"
      :project="project"
      :primary-name="props.primaryName(project)"
      :original-name="props.originalName(project)"
      :content-tags="props.contentTags(project)"
      :category-tags="props.categoryTags(project)"
      :source-label="props.sourceLabel(project.source)"
      :version-range="props.versionRange(project)"
      :relative-time="props.relativeTime(project.dateModified)"
      :download-count="props.downloadCount(project.downloads)"
      :resource-icon="props.resourceIcon"
      :icon-failed="props.iconFailed(project)"
      @open="emit('open-project', project)"
      @icon-error="emit('icon-error', $event)"
    />

    <div ref="loadSentinel" class="mod-load-sentinel" aria-hidden="true" />
    <div v-if="props.loadingMore" class="mod-loading-more" role="status">
      <span class="mod-loading-spinner" />
      正在加载更多
    </div>
    <div v-else-if="props.searchError" class="mod-inline-error mod-load-error" role="alert">
      <span>加载下一页失败：{{ props.searchError }}</span>
      <button type="button" @click="emit('retry-next-page')">重试</button>
    </div>
    <p v-else-if="!props.hasMore" class="mod-list-end">已加载全部结果</p>
  </div>
</template>

<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceFeedback.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceProjectResults.css"></style>
