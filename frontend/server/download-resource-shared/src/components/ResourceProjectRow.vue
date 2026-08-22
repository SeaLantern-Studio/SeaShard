<script setup lang="ts">
import type { ServerModProject } from "@seashard/contracts";
import { Box, Clock3, Download, UserRound } from "lucide-vue-next";
import type { Component } from "vue";

const props = defineProps<{
  project: ServerModProject;
  primaryName: string;
  originalName?: string;
  contentTags: readonly string[];
  categoryTags: readonly string[];
  sourceLabel: string;
  versionRange: string;
  relativeTime: string;
  downloadCount: string;
  resourceIcon: Component;
  iconFailed: boolean;
}>();

const emit = defineEmits<{
  open: [];
  "icon-error": [projectId: string];
}>();
</script>

<template>
  <button type="button" class="mod-project-row" @click="emit('open')">
    <span class="mod-project-icon">
      <img
        v-if="props.project.iconUrl && !props.iconFailed"
        :src="props.project.iconUrl"
        alt=""
        draggable="false"
        referrerpolicy="no-referrer"
        @error="emit('icon-error', props.project.id)"
      />
      <component
        :is="props.resourceIcon"
        v-else
        :size="24"
        :stroke-width="1.7"
        aria-hidden="true"
      />
    </span>
    <div class="mod-project-copy">
      <div class="mod-project-title-line">
        <strong>{{ props.primaryName }}</strong>
        <template v-if="props.originalName">
          <span class="mod-project-name-separator" aria-hidden="true">|</span>
          <span class="mod-project-original-name">{{ props.originalName }}</span>
        </template>
      </div>
      <div class="mod-project-description-line">
        <div v-if="props.contentTags.length > 0" class="mod-content-tags">
          <span
            v-for="contentTag in props.contentTags"
            :key="`content:${contentTag}`"
            class="mod-content-tag"
          >
            {{ contentTag }}
          </span>
        </div>
        <p>{{ props.project.description || "该项目暂未提供简介。" }}</p>
      </div>
      <div class="mod-project-footer">
        <div class="mod-category-tags">
          <span class="mod-source-tag">{{ props.sourceLabel }}</span>
          <span
            v-for="category in props.categoryTags"
            :key="`category:${category}`"
            class="mod-category-tag"
          >
            {{ category }}
          </span>
        </div>
        <div class="mod-project-meta">
          <span>
            <UserRound :size="14" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ props.project.author }}</span>
          </span>
          <span>
            <Box :size="14" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ props.versionRange }}</span>
          </span>
          <span>
            <Clock3 :size="14" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ props.relativeTime }}</span>
          </span>
        </div>
      </div>
    </div>
    <div class="mod-project-downloads" :aria-label="`${props.project.downloads} 次下载`">
      <Download :size="17" :stroke-width="1.9" aria-hidden="true" />
      <strong>{{ props.downloadCount }}</strong>
    </div>
  </button>
</template>
<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceProjectRow.css"></style>
