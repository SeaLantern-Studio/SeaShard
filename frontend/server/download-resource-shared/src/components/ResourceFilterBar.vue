<script setup lang="ts">
import { Cmz_Input, Cmz_Select, type SelectOption } from "cmzya-modern-ui";
import { Search } from "lucide-vue-next";
import type { ServerModSearchSource } from "../resource-presentation";

const props = defineProps<{
  resourceLabel: string;
  query: string;
  maximumQueryLength: number;
  source: ServerModSearchSource;
  sourceOptions: SelectOption[];
  tag: string;
  tagOptions: SelectOption[];
  sort: string;
  sortOptions: SelectOption[];
  gameVersion: string;
  versionOptions: SelectOption[];
  loader: string;
  loaderOptions: SelectOption[];
  showLoaderFilter: boolean;
  filtersLoading: boolean;
  filtersWarning: string;
  filtersError: string;
}>();
const emit = defineEmits<{
  "update:query": [value: string | number];
  "update:source": [value: string | number];
  "update:tag": [value: string | number];
  "update:sort": [value: string | number];
  "update:game-version": [value: string | number];
  "update:loader": [value: string | number];
  "retry-filters": [];
}>();
</script>

<template>
  <div class="mod-search-field">
    <Search class="mod-search-icon" :size="19" :stroke-width="1.9" aria-hidden="true" />
    <Cmz_Input
      class="mod-search-control"
      :model-value="props.query"
      :maxlength="props.maximumQueryLength"
      :placeholder="`搜索${props.resourceLabel}名称或关键词`"
      :aria-label="`搜索${props.resourceLabel}`"
      @update:model-value="emit('update:query', $event)"
    />
  </div>

  <div
    class="mod-filter-grid"
    :class="{ 'without-loader': !props.showLoaderFilter }"
    :aria-label="`${props.resourceLabel}搜索筛选`"
  >
    <label class="mod-filter-field">
      <span>来源</span>
      <Cmz_Select
        :model-value="props.source"
        :options="props.sourceOptions"
        :disabled="props.filtersLoading"
        @update:model-value="emit('update:source', $event)"
      />
    </label>
    <label class="mod-filter-field">
      <span>标签</span>
      <Cmz_Select
        :model-value="props.tag"
        :options="props.tagOptions"
        :disabled="props.filtersLoading"
        :searchable="true"
        placeholder="全部标签"
        @update:model-value="emit('update:tag', $event)"
      />
    </label>
    <label class="mod-filter-field">
      <span>排序</span>
      <Cmz_Select
        :model-value="props.sort"
        :options="props.sortOptions"
        @update:model-value="emit('update:sort', $event)"
      />
    </label>
    <label class="mod-filter-field">
      <span>版本</span>
      <Cmz_Select
        :model-value="props.gameVersion"
        :options="props.versionOptions"
        :disabled="props.filtersLoading"
        :searchable="true"
        placeholder="全部版本"
        @update:model-value="emit('update:game-version', $event)"
      />
    </label>
    <label v-if="props.showLoaderFilter" class="mod-filter-field">
      <span>加载器</span>
      <Cmz_Select
        :model-value="props.loader"
        :options="props.loaderOptions"
        :disabled="props.filtersLoading"
        :searchable="true"
        placeholder="全部加载器"
        @update:model-value="emit('update:loader', $event)"
      />
    </label>
  </div>

  <div v-if="props.filtersWarning" class="mod-inline-error" role="status">
    <span>部分来源筛选项暂时不可用：{{ props.filtersWarning }}</span>
    <button type="button" @click="emit('retry-filters')">重试</button>
  </div>
  <div v-if="props.filtersError" class="mod-inline-error" role="alert">
    <span>筛选项加载失败：{{ props.filtersError }}</span>
    <button type="button" @click="emit('retry-filters')">重试</button>
  </div>
</template>
<style scoped src="./ResourceFeedback.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceFilters.css"></style>
