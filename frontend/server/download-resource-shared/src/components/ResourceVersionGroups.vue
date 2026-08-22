<script setup lang="ts">
import type { ServerModVersion } from "@seashard/contracts";
import { ChevronDown, Clock3, Download } from "lucide-vue-next";
import type { Component } from "vue";
import type { ServerModVersionGroup } from "../resource-presentation";

const props = defineProps<{
  groups: readonly ServerModVersionGroup[];
  expandedGroupId?: string;
  showLoaderFilter: boolean;
  loaderLabel: (id: string) => string;
  selectedProjectIconUrl?: string;
  iconFailed: boolean;
  resourceIcon: Component;
  downloadEnabled: boolean;
  formatDownloadCount: (value: number) => string;
  formatRelativeTime: (value: string) => string;
}>();

const emit = defineEmits<{
  "toggle-group": [groupId: string];
  "select-version": [version: ServerModVersion];
  "icon-error": [];
}>();
</script>

<template>
  <div v-if="props.groups.length === 0" class="mod-result-state mod-detail-state">
    <strong>没有符合筛选条件的版本</strong>
    <span>{{
      props.showLoaderFilter
        ? "尝试选择其他 Minecraft 版本或加载器。"
        : "尝试选择其他 Minecraft 版本。"
    }}</span>
  </div>
  <div v-else class="mod-version-groups">
    <article
      v-for="group in props.groups"
      :key="group.id"
      class="mod-version-group"
      :class="{ expanded: props.expandedGroupId === group.id }"
    >
      <button
        class="mod-version-group-trigger"
        type="button"
        :aria-expanded="props.expandedGroupId === group.id"
        @click="emit('toggle-group', group.id)"
      >
        <strong>
          <template v-if="props.showLoaderFilter && group.loader">
            {{ props.loaderLabel(group.loader) }}
          </template>
          {{ group.gameVersion }}
        </strong>
        <span>{{ group.versions.length }} 个文件</span>
        <ChevronDown :size="18" :stroke-width="1.8" aria-hidden="true" />
      </button>
      <div v-show="props.expandedGroupId === group.id" class="mod-version-items">
        <button
          v-for="version in group.versions"
          :key="version.id"
          class="mod-version-item"
          type="button"
          :disabled="!props.downloadEnabled"
          :aria-label="
            props.downloadEnabled ? `下载 ${version.fileName}` : `${version.fileName}，下载暂未开放`
          "
          @click="emit('select-version', version)"
        >
          <span class="mod-project-icon mod-version-icon">
            <img
              v-if="props.selectedProjectIconUrl && !props.iconFailed"
              :src="props.selectedProjectIconUrl"
              alt=""
              draggable="false"
              referrerpolicy="no-referrer"
              @error="emit('icon-error')"
            />
            <component
              :is="props.resourceIcon"
              v-else
              :size="16"
              :stroke-width="1.7"
              aria-hidden="true"
            />
          </span>
          <strong>{{ version.fileName }}</strong>
          <span class="mod-version-meta">
            <Download :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ props.formatDownloadCount(version.downloads) }}
          </span>
          <span class="mod-version-meta">
            <Clock3 :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ props.formatRelativeTime(version.datePublished) }}
          </span>
        </button>
      </div>
    </article>
  </div>
</template>
<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceFeedback.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceVersionGroups.css"></style>
