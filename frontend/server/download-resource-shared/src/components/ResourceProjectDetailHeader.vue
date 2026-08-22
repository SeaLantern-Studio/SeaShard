<script setup lang="ts">
import { Cmz_Markdown } from "cmzya-modern-ui";
import type { ServerModProject } from "@seashard/contracts";
import {
  Box,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Heart,
  Link2,
  UserRound,
  X,
} from "lucide-vue-next";
import type { Component } from "vue";

type DetailCopyState = "idle" | "success" | "error";

const props = defineProps<{
  resourceLabel: string;
  project: ServerModProject;
  primaryName: string;
  originalName?: string;
  categoryTags: readonly string[];
  contentTags: readonly string[];
  versionRange: string;
  relativeTime: string;
  downloadCount: string;
  description: string;
  descriptionExpanded: boolean;
  selectedIsFavorite: boolean;
  copyNameState: DetailCopyState;
  copyLinkState: DetailCopyState;
  copyNameLabel: string;
  copyLinkLabel: string;
  resourceIcon: Component;
  iconFailed: boolean;
}>();

const emit = defineEmits<{
  "icon-error": [projectId: string];
  "toggle-description": [];
  "copy-name": [];
  "copy-link": [];
  "toggle-favorite": [];
}>();

const detailMarkdownFeatures = {
  alert: false,
  linkCard: false,
  container: false,
} as const;

function openDetailMarkdownLink(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;

  event.preventDefault();
  window.open(link.href, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <section class="mod-detail-summary" :aria-label="`${props.resourceLabel}项目信息`">
    <div class="mod-detail-summary-main">
      <span class="mod-project-icon mod-detail-icon">
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
          :size="28"
          :stroke-width="1.7"
          aria-hidden="true"
        />
      </span>
      <div class="mod-detail-project-copy">
        <div class="mod-project-title-line mod-detail-title-line">
          <strong>{{ props.primaryName }}</strong>
          <template v-if="props.originalName">
            <span class="mod-project-name-separator" aria-hidden="true">|</span>
            <span class="mod-project-original-name">{{ props.originalName }}</span>
          </template>
        </div>
        <div class="mod-detail-tags">
          <span
            v-for="category in props.categoryTags"
            :key="`detail-category:${category}`"
            class="mod-category-tag"
          >
            {{ category }}
          </span>
          <span
            v-for="contentTag in props.contentTags"
            :key="`detail-content:${contentTag}`"
            class="mod-content-tag"
          >
            {{ contentTag }}
          </span>
        </div>
        <div class="mod-detail-meta">
          <span>
            <UserRound :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ props.project.author }}
          </span>
          <span>
            <Box :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ props.versionRange }}
          </span>
          <span>
            <Clock3 :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ props.relativeTime }}
          </span>
        </div>
      </div>
      <div
        class="mod-project-downloads mod-detail-downloads"
        :aria-label="`${props.project.downloads} 次下载`"
      >
        <Download :size="18" :stroke-width="1.9" aria-hidden="true" />
        <strong>{{ props.downloadCount }}</strong>
      </div>
    </div>

    <div class="mod-detail-description-block" :class="{ expanded: props.descriptionExpanded }">
      <div class="mod-detail-description" @click="openDetailMarkdownLink">
        <Cmz_Markdown
          :content="props.description"
          variant="plain"
          :code-highlight="false"
          :features="detailMarkdownFeatures"
        />
      </div>
      <button
        class="mod-detail-description-toggle"
        type="button"
        :aria-expanded="props.descriptionExpanded"
        @click="emit('toggle-description')"
      >
        {{ props.descriptionExpanded ? "收起简介" : "展开简介" }}
        <ChevronDown :size="15" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </div>

    <div class="mod-detail-actions" :aria-label="`${props.resourceLabel}项目操作`">
      <button
        class="mod-detail-action"
        :class="`copy-${props.copyNameState}`"
        type="button"
        aria-live="polite"
        @click="emit('copy-name')"
      >
        <Check
          v-if="props.copyNameState === 'success'"
          :size="15"
          :stroke-width="2"
          aria-hidden="true"
        />
        <X
          v-else-if="props.copyNameState === 'error'"
          :size="15"
          :stroke-width="2"
          aria-hidden="true"
        />
        <Copy v-else :size="15" :stroke-width="1.8" aria-hidden="true" />
        {{ props.copyNameLabel }}
      </button>
      <button
        class="mod-detail-action"
        :class="`copy-${props.copyLinkState}`"
        type="button"
        aria-live="polite"
        @click="emit('copy-link')"
      >
        <Check
          v-if="props.copyLinkState === 'success'"
          :size="15"
          :stroke-width="2"
          aria-hidden="true"
        />
        <X
          v-else-if="props.copyLinkState === 'error'"
          :size="15"
          :stroke-width="2"
          aria-hidden="true"
        />
        <Link2 v-else :size="15" :stroke-width="1.8" aria-hidden="true" />
        {{ props.copyLinkLabel }}
      </button>
      <button
        class="mod-detail-action"
        :class="{ active: props.selectedIsFavorite }"
        type="button"
        :aria-pressed="props.selectedIsFavorite"
        @click="emit('toggle-favorite')"
      >
        <Heart
          :size="15"
          :stroke-width="1.8"
          :fill="props.selectedIsFavorite ? 'currentColor' : 'none'"
          aria-hidden="true"
        />
        {{ props.selectedIsFavorite ? "已收藏" : "收藏" }}
      </button>
    </div>
  </section>
</template>
<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceProjectDetailHeader.css"></style>
