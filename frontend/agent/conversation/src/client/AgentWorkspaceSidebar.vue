<script setup lang="ts">
import { agentWorkspace } from "@seashard/agent-ui-shared";
import { ChevronDown, Folder, MessageSquare, SquarePen } from "lucide-vue-next";
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const scrollViewport = ref<HTMLElement>();
const scrollContent = ref<HTMLElement>();
const scrollbarTrack = ref<HTMLElement>();
const scrollbarThumb = ref<HTMLElement>();
const projects = [{ name: "SeaShard", threads: ["界面布局规划", "组件运行时设计"] }] as const;
const expandedProjects = ref<Set<string>>(new Set(projects.map((project) => project.name)));

interface ScrollbarDrag {
  readonly pointerId: number;
  readonly startClientY: number;
  readonly startScrollTop: number;
}

let scrollbarDrag: ScrollbarDrag | undefined;
let scrollbarFrame: number | undefined;
let scrollbarResizeObserver: ResizeObserver | undefined;

function navigateToConversation(): void {
  void router.push("/agent/chat");
}

function createConversation(): void {
  agentWorkspace.createDraft();
  navigateToConversation();
}

function selectConversation(conversationId: string): void {
  agentWorkspace.select(conversationId);
  navigateToConversation();
}

function isConversationActive(conversationId: string): boolean {
  return agentWorkspace.activeConversationId.value === conversationId;
}

function isProjectExpanded(name: string): boolean {
  return expandedProjects.value.has(name);
}

function toggleProject(name: string): void {
  const next = new Set(expandedProjects.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  expandedProjects.value = next;
}

/** 原生区域承担滚动语义；代理轨道只投影尺寸与位置，不建立第二份滚动状态。 */
function scheduleScrollbar(): void {
  if (scrollbarFrame !== undefined) return;
  scrollbarFrame = requestAnimationFrame(renderScrollbar);
}

function renderScrollbar(): void {
  scrollbarFrame = undefined;
  const viewport = scrollViewport.value;
  const track = scrollbarTrack.value;
  const thumb = scrollbarThumb.value;
  if (!viewport || !track || !thumb) return;

  const maximumScroll = viewport.scrollHeight - viewport.clientHeight;
  const trackHeight = track.clientHeight;
  const visible = maximumScroll > 1 && trackHeight > 0;
  track.classList.toggle("is-visible", visible);
  if (!visible) return;

  const thumbHeight = Math.max(
    28,
    Math.min(trackHeight, trackHeight * (viewport.clientHeight / viewport.scrollHeight)),
  );
  const thumbRange = trackHeight - thumbHeight;
  const thumbTop = thumbRange > 0 ? (viewport.scrollTop / maximumScroll) * thumbRange : 0;
  thumb.style.height = `${thumbHeight}px`;
  thumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
}

/** 内容和视口任一尺寸变化都会重新计算代理滑块，避免会话刷新后滑块失真。 */
function connectScrollbarObserver(): void {
  scrollbarResizeObserver?.disconnect();
  const viewport = scrollViewport.value;
  const content = scrollContent.value;
  if (!viewport || !content) return;
  scrollbarResizeObserver ??= new ResizeObserver(scheduleScrollbar);
  scrollbarResizeObserver.observe(viewport);
  scrollbarResizeObserver.observe(content);
  scheduleScrollbar();
}

function seekScrollbar(event: PointerEvent): void {
  if (event.button !== 0) return;
  const viewport = scrollViewport.value;
  const track = scrollbarTrack.value;
  const thumb = scrollbarThumb.value;
  if (!viewport || !track || !thumb) return;
  const maximumScroll = viewport.scrollHeight - viewport.clientHeight;
  const thumbRange = track.clientHeight - thumb.offsetHeight;
  if (maximumScroll <= 0 || thumbRange <= 0) return;
  const trackRect = track.getBoundingClientRect();
  const target = Math.min(
    thumbRange,
    Math.max(0, event.clientY - trackRect.top - thumb.offsetHeight / 2),
  );
  viewport.scrollTop = (target / thumbRange) * maximumScroll;
}

function beginScrollbarDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  const viewport = scrollViewport.value;
  const thumb = scrollbarThumb.value;
  if (!viewport || !thumb) return;
  event.preventDefault();
  scrollbarDrag = {
    pointerId: event.pointerId,
    startClientY: event.clientY,
    startScrollTop: viewport.scrollTop,
  };
  thumb.setPointerCapture(event.pointerId);
  thumb.classList.add("is-dragging");
}

function moveScrollbarDrag(event: PointerEvent): void {
  const drag = scrollbarDrag;
  const viewport = scrollViewport.value;
  const track = scrollbarTrack.value;
  const thumb = scrollbarThumb.value;
  if (!drag || drag.pointerId !== event.pointerId || !viewport || !track || !thumb) return;
  const maximumScroll = viewport.scrollHeight - viewport.clientHeight;
  const thumbRange = track.clientHeight - thumb.offsetHeight;
  if (maximumScroll <= 0 || thumbRange <= 0) return;
  viewport.scrollTop =
    drag.startScrollTop + ((event.clientY - drag.startClientY) / thumbRange) * maximumScroll;
}

function endScrollbarDrag(event: PointerEvent): void {
  const drag = scrollbarDrag;
  const thumb = scrollbarThumb.value;
  if (!drag || drag.pointerId !== event.pointerId) return;
  scrollbarDrag = undefined;
  if (thumb?.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
  thumb?.classList.remove("is-dragging");
}

onMounted(() => {
  void nextTick(connectScrollbarObserver);
  window.addEventListener("resize", scheduleScrollbar);
});

onUnmounted(() => {
  if (scrollbarFrame !== undefined) cancelAnimationFrame(scrollbarFrame);
  scrollbarResizeObserver?.disconnect();
  window.removeEventListener("resize", scheduleScrollbar);
});
</script>

<template>
  <div class="agent-workspace-nav">
    <button type="button" class="workspace-action" @click="createConversation">
      <SquarePen :size="16" :stroke-width="1.8" />
      <span>新建对话</span>
    </button>

    <div class="agent-workspace-scroll-shell">
      <div ref="scrollViewport" class="agent-workspace-scroll" @scroll.passive="scheduleScrollbar">
        <div ref="scrollContent" class="agent-workspace-scroll-content">
          <section class="workspace-section" aria-labelledby="projects-label">
            <h3 id="projects-label" class="workspace-section-title">
              <span class="workspace-section-title-text">项目</span>
            </h3>
            <div v-for="project in projects" :key="project.name" class="workspace-project">
              <button
                type="button"
                class="workspace-row workspace-project-row"
                :aria-expanded="isProjectExpanded(project.name)"
                :aria-controls="`project-${project.name}-threads`"
                @click="toggleProject(project.name)"
              >
                <Folder :size="15" :stroke-width="1.8" />
                <span>{{ project.name }}</span>
                <ChevronDown
                  class="workspace-project-chevron"
                  :class="{ expanded: isProjectExpanded(project.name) }"
                  :size="15"
                  :stroke-width="1.8"
                />
              </button>
              <div
                :id="`project-${project.name}-threads`"
                class="workspace-project-threads"
                :class="{ expanded: isProjectExpanded(project.name) }"
                :aria-hidden="!isProjectExpanded(project.name)"
                :inert="!isProjectExpanded(project.name)"
              >
                <div class="workspace-project-threads-inner">
                  <button
                    v-for="thread in project.threads"
                    :key="thread"
                    type="button"
                    class="workspace-row workspace-thread-row"
                  >
                    <MessageSquare :size="14" :stroke-width="1.8" />
                    <span>{{ thread }}</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="workspace-section" aria-labelledby="chats-label">
            <h3 id="chats-label" class="workspace-section-title">
              <span class="workspace-section-title-text">对话</span>
            </h3>
            <button
              v-for="chat in agentWorkspace.conversations.value"
              :key="chat.id"
              type="button"
              class="workspace-row workspace-chat-row"
              :class="{ active: isConversationActive(chat.id) }"
              :aria-current="isConversationActive(chat.id) ? 'page' : undefined"
              @click="selectConversation(chat.id)"
            >
              <MessageSquare :size="14" :stroke-width="1.8" />
              <span>{{ chat.title }}</span>
            </button>
          </section>
        </div>
      </div>
      <div
        ref="scrollbarTrack"
        class="agent-proxy-scrollbar"
        aria-hidden="true"
        @pointerdown.self="seekScrollbar"
      >
        <div
          ref="scrollbarThumb"
          class="agent-proxy-scrollbar-thumb"
          @pointerdown.stop="beginScrollbarDrag"
          @pointermove="moveScrollbarDrag"
          @pointerup="endScrollbarDrag"
          @pointercancel="endScrollbarDrag"
        ></div>
      </div>
    </div>
  </div>
</template>

<style src="./AgentWorkspaceSidebar.css" scoped></style>
