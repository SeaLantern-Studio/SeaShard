<script setup lang="ts">
import type { ServerConfigurationFileKind } from "@seashard/contracts";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { configurationLanguage, configurationSyntaxHighlighting } from "./config-code-mirror";
import type { ConfigurationDiffLine, ConfigurationDiffLineType } from "./config-diff";

const props = defineProps<{
  lines: readonly ConfigurationDiffLine[];
  kind: ServerConfigurationFileKind;
}>();

const editorRoot = ref<HTMLElement>();
let editorView: EditorView | undefined;

class DiffMarker extends GutterMarker {
  constructor(
    private readonly value: string,
    private readonly type?: ConfigurationDiffLineType,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.type
      ? `cm-diff-gutter-marker cm-diff-gutter-marker--${this.type}`
      : "cm-diff-gutter-marker";
    element.textContent = this.value;
    return element;
  }
}

function createLineDecorations(lines: readonly ConfigurationDiffLine[]) {
  return StateField.define({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>();
      lines.forEach((diffLine, index) => {
        const line = state.doc.line(index + 1);
        builder.add(
          line.from,
          line.from,
          Decoration.line({ attributes: { class: `cm-diff-line cm-diff-line--${diffLine.type}` } }),
        );
      });
      return builder.finish();
    },
    update: (value) => value,
    provide: (field) => EditorView.decorations.from(field),
  });
}

function createNumberGutter(lines: readonly ConfigurationDiffLine[], side: "old" | "new") {
  const maxNumber = lines.reduce(
    (maximum, line) =>
      Math.max(maximum, side === "old" ? (line.leftNumber ?? 0) : (line.rightNumber ?? 0)),
    1,
  );
  return gutter({
    class: `cm-diff-gutter cm-diff-gutter--${side}`,
    renderEmptyElements: true,
    initialSpacer: () => new DiffMarker(String(maxNumber)),
    lineMarker(view, line) {
      const diffLine = lines[view.state.doc.lineAt(line.from).number - 1];
      const number = side === "old" ? diffLine?.leftNumber : diffLine?.rightNumber;
      return new DiffMarker(
        number === null || number === undefined ? "" : String(number),
        diffLine?.type,
      );
    },
  });
}

function createSignGutter(lines: readonly ConfigurationDiffLine[]) {
  return gutter({
    class: "cm-diff-sign-gutter",
    renderEmptyElements: true,
    initialSpacer: () => new DiffMarker("+"),
    lineMarker(view, line) {
      const diffLine = lines[view.state.doc.lineAt(line.from).number - 1];
      return new DiffMarker(diffLine?.type === "addition" ? "+" : "−", diffLine?.type);
    },
  });
}

function createEditor(): void {
  if (!editorRoot.value) return;
  editorView?.destroy();
  const state = EditorState.create({
    doc: props.lines.map((line) => line.text).join("\n"),
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      configurationLanguage(props.kind),
      configurationSyntaxHighlighting,
      createLineDecorations(props.lines),
      createNumberGutter(props.lines, "old"),
      createNumberGutter(props.lines, "new"),
      createSignGutter(props.lines),
      EditorView.theme({
        "&": {
          minHeight: "280px",
          overflow: "hidden",
          border: "1px solid var(--sl-border-light)",
          borderRadius: "11px",
          backgroundColor: "var(--sl-surface)",
        },
        ".cm-scroller": {
          maxHeight: "min(56vh, 560px)",
          overflow: "auto",
          fontFamily: "var(--sl-font-mono)",
          fontSize: "var(--sl-font-size-base)",
          lineHeight: "1.55",
        },
        ".cm-content": { padding: "0" },
        ".cm-line": { padding: "0 12px" },
        ".cm-gutters": {
          backgroundColor: "var(--sl-bg-secondary)",
          color: "var(--sl-text-tertiary)",
          borderRight: "1px solid var(--sl-border-light)",
        },
        ".cm-diff-gutter": { minWidth: "48px" },
        ".cm-diff-sign-gutter": { minWidth: "30px" },
        ".cm-diff-gutter .cm-gutterElement, .cm-diff-sign-gutter .cm-gutterElement": {
          padding: "0 9px",
          textAlign: "right",
        },
        ".cm-diff-gutter-marker": {
          display: "flex",
          width: "calc(100% + 18px)",
          minHeight: "100%",
          alignItems: "center",
          justifyContent: "flex-end",
          boxSizing: "border-box",
          margin: "0 -9px",
          padding: "0 9px",
        },
        ".cm-diff-line": { borderTop: "1px solid rgba(148, 163, 184, 0.08)" },
        ".cm-diff-line--addition, .cm-diff-gutter-marker--addition": {
          backgroundColor: "rgba(34, 197, 94, 0.13)",
        },
        ".cm-diff-line--deletion, .cm-diff-gutter-marker--deletion": {
          backgroundColor: "rgba(239, 68, 68, 0.13)",
        },
        ".cm-diff-sign-gutter .cm-diff-gutter-marker--addition": {
          color: "var(--sl-success)",
          fontWeight: "700",
        },
        ".cm-diff-sign-gutter .cm-diff-gutter-marker--deletion": {
          color: "var(--sl-error)",
          fontWeight: "700",
        },
        ".cm-activeLine": { backgroundColor: "transparent" },
        "&.cm-focused": { outline: "none" },
      }),
    ],
  });
  editorView = new EditorView({ state, parent: editorRoot.value });
}

onMounted(createEditor);
watch(
  () => [props.lines, props.kind],
  async () => {
    await nextTick();
    createEditor();
  },
);
onBeforeUnmount(() => {
  editorView?.destroy();
  editorView = undefined;
});
</script>

<template>
  <div ref="editorRoot" class="configuration-diff-root"></div>
</template>

<style scoped>
.configuration-diff-root {
  min-height: 0;
}
</style>
