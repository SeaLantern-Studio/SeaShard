<script setup lang="ts">
import type { ServerConfigurationFileKind } from "@seashard/contracts";
import { SearchQuery, findNext, findPrevious, search, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Cmz_Button, Cmz_Input } from "cmzya-modern-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { configurationLanguage, configurationSyntaxHighlighting } from "./config-code-mirror";

const props = defineProps<{
  modelValue: string;
  kind: ServerConfigurationFileKind;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorRoot = ref<HTMLElement>();
const searchText = ref("");
const totalMatches = ref(0);
const currentMatch = ref(0);
let editorView: EditorView | undefined;

const searchQuery = computed(
  () =>
    new SearchQuery({
      search: searchText.value,
      caseSensitive: false,
      literal: true,
    }),
);
const matchCountText = computed(() => `${currentMatch.value} / ${totalMatches.value}`);
const canNavigate = computed(() => totalMatches.value > 0);

function matchRanges(text: string, query: string): Array<{ from: number; to: number }> {
  if (!query) return [];
  const ranges: Array<{ from: number; to: number }> = [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    ranges.push({ from: found, to: found + needle.length });
    offset = found + needle.length;
  }
  return ranges;
}

function updateMatchStats(): void {
  if (!editorView || !searchText.value) {
    totalMatches.value = 0;
    currentMatch.value = 0;
    return;
  }
  const ranges = matchRanges(editorView.state.doc.toString(), searchText.value);
  totalMatches.value = ranges.length;
  if (ranges.length === 0) {
    currentMatch.value = 0;
    return;
  }
  const selection = editorView.state.selection.main;
  const exact = ranges.findIndex(
    (range) => range.from === selection.from && range.to === selection.to,
  );
  const nearest = ranges.findIndex((range) => range.from >= selection.to);
  currentMatch.value = exact >= 0 ? exact + 1 : nearest >= 0 ? nearest + 1 : ranges.length;
}

function applySearchQuery(): void {
  if (!editorView) return;
  editorView.dispatch({ effects: setSearchQuery.of(searchQuery.value) });
  updateMatchStats();
}

function navigateToPrevious(): void {
  if (!editorView || !canNavigate.value) return;
  editorView.focus();
  if (findPrevious(editorView)) {
    editorView.dispatch({ scrollIntoView: true });
    updateMatchStats();
  }
}

function navigateToNext(): void {
  if (!editorView || !canNavigate.value) return;
  editorView.focus();
  if (findNext(editorView)) {
    editorView.dispatch({ scrollIntoView: true });
    updateMatchStats();
  }
}

onMounted(() => {
  if (!editorRoot.value) return;
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      EditorView.lineWrapping,
      configurationLanguage(props.kind),
      configurationSyntaxHighlighting,
      search({ top: false }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
        if (update.docChanged || update.selectionSet) updateMatchStats();
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          minHeight: "0",
          overflow: "hidden",
          border: "1px solid var(--sl-border-light)",
          borderRadius: "var(--sl-radius-md)",
          backgroundColor: "var(--sl-surface)",
        },
        ".cm-scroller": {
          overflow: "auto",
          padding: "0",
          fontFamily: "var(--sl-font-mono)",
          fontSize: "var(--sl-font-size-sm)",
          lineHeight: "1.45",
        },
        ".cm-gutters": {
          backgroundColor: "var(--sl-bg-secondary)",
          color: "var(--sl-text-tertiary)",
          borderRight: "1px solid var(--sl-border-light)",
        },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px" },
        ".cm-content": {
          padding: "0 12px",
          color: "var(--sl-text-primary)",
          caretColor: "var(--sl-primary)",
        },
        ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
        ".cm-searchMatch": {
          backgroundColor: "color-mix(in srgb, var(--sl-warning) 30%, transparent)",
          outline: "1px solid color-mix(in srgb, var(--sl-warning) 50%, transparent)",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "color-mix(in srgb, var(--sl-primary) 25%, transparent)",
          outline: "1px solid color-mix(in srgb, var(--sl-primary) 45%, transparent)",
        },
        "&.cm-focused": {
          outline: "none",
          borderColor: "var(--sl-primary-light)",
          boxShadow: "0 0 0 2px var(--sl-primary-bg)",
        },
      }),
    ],
  });
  editorView = new EditorView({ state, parent: editorRoot.value });
  applySearchQuery();
});

watch(
  () => props.modelValue,
  (value) => {
    if (!editorView || value === editorView.state.doc.toString()) return;
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: value },
    });
  },
);
watch(searchText, applySearchQuery);

onBeforeUnmount(() => {
  editorView?.destroy();
  editorView = undefined;
});
</script>

<template>
  <div class="source-editor-panel">
    <div class="source-search-toolbar">
      <div class="toolbar-left">
        <Cmz_Input
          v-model="searchText"
          class="source-search-input"
          placeholder="搜索源文件"
          aria-label="搜索源文件"
        />
        <span class="source-search-count">{{ matchCountText }}</span>
      </div>
      <div class="toolbar-right">
        <Cmz_Button
          variant="outline"
          size="sm"
          :disabled="!canNavigate"
          @click="navigateToPrevious"
        >
          上一个
        </Cmz_Button>
        <Cmz_Button variant="outline" size="sm" :disabled="!canNavigate" @click="navigateToNext">
          下一个
        </Cmz_Button>
      </div>
    </div>
    <div ref="editorRoot" class="source-cm-root"></div>
  </div>
</template>

<style scoped>
.source-editor-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--sl-space-sm);
}

.source-search-toolbar {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-md);
  padding: var(--sl-space-xs);
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-md);
  background: var(--sl-surface);
}

.toolbar-left {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--sl-space-sm);
}

.toolbar-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--sl-space-sm);
}

.source-search-input {
  width: min(320px, 100%);
  min-width: 0;
}

.source-search-count {
  min-width: 64px;
  flex: 0 0 auto;
  color: var(--sl-text-secondary);
  font-family: var(--sl-font-mono);
  font-size: var(--sl-font-size-xs);
  white-space: nowrap;
}

.source-cm-root {
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
}

.source-cm-root :deep(.cm-editor) {
  width: 100%;
  height: 100%;
}

@media (max-width: 640px) {
  .source-search-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .toolbar-right {
    justify-content: flex-end;
  }
}
</style>
