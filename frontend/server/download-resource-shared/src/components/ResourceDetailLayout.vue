<script setup lang="ts">
import { ArrowLeft } from "lucide-vue-next";
const props = defineProps<{
  resourceLabel: string;
}>();

const emit = defineEmits<{
  back: [];
}>();
</script>

<template>
  <div class="mod-detail-page">
    <button class="mod-detail-back" type="button" @click="emit('back')">
      <ArrowLeft :size="18" :stroke-width="1.9" aria-hidden="true" />
      返回{{ props.resourceLabel }}列表
    </button>
    <slot />
  </div>
</template>

<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceDetailLayout.css"></style>
