<script setup lang="ts">
import {
  ClientUiSlotEntry,
  useClientUiRuntime,
  type RegisteredPageRootExtension,
} from "@seashard/ui-runtime";
import type { PageRootExtensionProps } from "@seashard/ui-sdk";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  pageId: string;
}>();

const runtime = useClientUiRuntime();
const root = ref<HTMLElement>();
const extensions = computed(() => runtime.pageRootExtensions(props.pageId));
const prependExtensions = computed(() => byMode(extensions.value, "prepend"));
const appendExtensions = computed(() => byMode(extensions.value, "append"));
const overlayExtensions = computed(() => byMode(extensions.value, "overlay"));
const domExtensions = computed(() => byMode(extensions.value, "dom"));
const replacement = computed(() => byMode(extensions.value, "replace")[0]);
const extensionProps = computed<PageRootExtensionProps | undefined>(() => {
  const element = root.value;
  return element ? { pageId: props.pageId, root: element } : undefined;
});

/** 页面可见期就是根 Slot 声明期；切页先坍缩旧 Slot，再声明新页面。 */
watch(
  () => props.pageId,
  (pageId, _previous, onCleanup) => {
    const close = runtime.openPageRoot(pageId);
    onCleanup(() => void close());
  },
  { immediate: true },
);

function byMode(
  entries: readonly RegisteredPageRootExtension[],
  mode: RegisteredPageRootExtension["mode"],
): readonly RegisteredPageRootExtension[] {
  return entries.filter((entry) => entry.mode === mode);
}
</script>

<template>
  <div ref="root" class="page-extension-root" :data-seashard-page-id="props.pageId">
    <template v-if="extensionProps">
      <ClientUiSlotEntry
        v-for="entry in prependExtensions"
        :key="entry.entryToken"
        :entry-token="entry.entryToken"
        :owner="extensionProps"
      />
    </template>

    <div class="page-extension-content">
      <template v-if="replacement && extensionProps">
        <ClientUiSlotEntry :entry-token="replacement.entryToken" :owner="extensionProps" />
      </template>
      <slot v-else />
    </div>

    <template v-if="extensionProps">
      <ClientUiSlotEntry
        v-for="entry in appendExtensions"
        :key="entry.entryToken"
        :entry-token="entry.entryToken"
        :owner="extensionProps"
      />

      <div v-if="overlayExtensions.length" class="page-extension-overlay">
        <ClientUiSlotEntry
          v-for="entry in overlayExtensions"
          :key="entry.entryToken"
          :entry-token="entry.entryToken"
          :owner="extensionProps"
        />
      </div>

      <div v-if="domExtensions.length" class="page-extension-dom-host" aria-hidden="true">
        <ClientUiSlotEntry
          v-for="entry in domExtensions"
          :key="entry.entryToken"
          :entry-token="entry.entryToken"
          :owner="extensionProps"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.page-extension-root {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 100%;
  flex-direction: column;
}

.page-extension-content {
  position: relative;
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
}

.page-extension-overlay {
  position: absolute;
  z-index: 20;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.page-extension-dom-host {
  display: none;
}
</style>
