<script setup lang="ts">
import { Cmz_Select, type SelectOption } from "cmzya-modern-ui";

const props = defineProps<{
  resourceLabel: string;
  showLoaderFilter: boolean;
  gameVersion: string;
  gameVersionOptions: SelectOption[];
  loader: string;
  loaderOptions: SelectOption[];
}>();

const emit = defineEmits<{
  "update:game-version": [value: string | number];
  "update:loader": [value: string | number];
}>();
</script>

<template>
  <div
    class="mod-filter-grid mod-detail-filter-grid"
    :class="{ 'single-filter': !props.showLoaderFilter }"
    :aria-label="`${props.resourceLabel}版本筛选`"
  >
    <label class="mod-filter-field">
      <span>版本</span>
      <Cmz_Select
        :model-value="props.gameVersion"
        :options="props.gameVersionOptions"
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
        :searchable="true"
        placeholder="全部加载器"
        @update:model-value="emit('update:loader', $event)"
      />
    </label>
  </div>
</template>
<style scoped src="./ResourceFilters.css"></style>
<style scoped src="./ResourceVersionFilters.css"></style>
