<script setup lang="ts">
import type { FileDownloadTaskSnapshot } from "@seashard/contracts";
import { AlertCircle, Check, Download, X, XCircle } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

const pollIntervalMs = 800;
const finishedDismissMs = 30_000;
const viewedDismissMs = 8_000;

const root = ref<HTMLElement>();
const currentTask = ref<FileDownloadTaskSnapshot>();
const panelOpen = ref(false);
const speedBytesPerSecond = ref(0);
const ringSize = reactive({ width: 0, height: 0 });
const hiddenTaskIds = new Set<string>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;
let refreshPending = false;
let trackedTaskId: string | undefined;
let lastDownloadedBytes = 0;
let lastSampleAt = 0;
let scheduledFinishedTaskId: string | undefined;
let ringObserver: ResizeObserver | undefined;

const isFinished = computed(() =>
  currentTask.value
    ? ["completed", "failed", "cancelled"].includes(currentTask.value.state)
    : false,
);
const isActive = computed(
  () => currentTask.value?.state === "queued" || currentTask.value?.state === "downloading",
);
const isCompleted = computed(() => currentTask.value?.state === "completed");
const isFailed = computed(() => currentTask.value?.state === "failed");
const isCancelled = computed(() => currentTask.value?.state === "cancelled");
const progress = computed(() => clampProgress(currentTask.value?.progress ?? 0));
const fileName = computed(() => {
  const path = currentTask.value?.destinationPath;
  return path?.split(/[\\/]/u).at(-1) ?? "下载任务";
});
const stateLabel = computed(() => {
  if (isCompleted.value) return "下载完成";
  if (isFailed.value) return "下载失败";
  if (isCancelled.value) return "已取消";
  if (currentTask.value?.state === "queued") return "等待下载";
  return "正在下载";
});
const statusIcon = computed(() => {
  if (isCompleted.value) return Check;
  if (isFailed.value) return AlertCircle;
  if (isCancelled.value) return XCircle;
  return Download;
});
const taskClass = computed(() => ({
  completed: isCompleted.value,
  failed: isFailed.value,
  cancelled: isCancelled.value,
  expanded: panelOpen.value,
}));
const downloadedSize = computed(() => formatBytes(currentTask.value?.downloadedBytes ?? 0));
const totalSize = computed(() => {
  const bytes = currentTask.value?.totalBytes ?? 0;
  return bytes > 0 ? formatBytes(bytes) : "未知";
});
const speedText = computed(() =>
  speedBytesPerSecond.value > 0 ? `${formatBytes(speedBytesPerSecond.value)}/s` : "--",
);
const ringRadius = computed(() => Math.max(0, (ringSize.height - 2) / 2));

onMounted(() => {
  void refreshTasks();
  pollTimer = setInterval(() => void refreshTasks(), pollIntervalMs);
  document.addEventListener("pointerdown", closeFromOutside);
});

onBeforeUnmount(() => {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  ringObserver?.disconnect();
  clearDismissTimer();
  document.removeEventListener("pointerdown", closeFromOutside);
});

watch(
  () => currentTask.value?.id,
  () => void nextTick(bindRingObserver),
);

/** 统一轮询 Host 侧任务；优先展示最新的活动任务，结束后保留结果提示。 */
async function refreshTasks(): Promise<void> {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const tasks = (await window.seashard.fileDownloads.listTasks()).filter(
      (task) => !hiddenTaskIds.has(task.id),
    );
    const newestFirst = [...tasks].reverse();
    const next = newestFirst.find((task) => !isTerminal(task.state)) ?? newestFirst[0];
    applyTask(next);
  } catch {
    // IPC 短暂失败不覆盖最后一次有效进度；下一次轮询会自动恢复。
  } finally {
    refreshPending = false;
  }
}

function applyTask(next: FileDownloadTaskSnapshot | undefined): void {
  const now = performance.now();
  if (!next) {
    currentTask.value = undefined;
    resetSpeedSample();
    return;
  }

  if (trackedTaskId === next.id && next.state === "downloading" && lastSampleAt > 0) {
    const elapsedSeconds = (now - lastSampleAt) / 1000;
    const downloadedDelta = next.downloadedBytes - lastDownloadedBytes;
    speedBytesPerSecond.value =
      elapsedSeconds > 0 ? Math.max(0, downloadedDelta / elapsedSeconds) : 0;
  } else if (trackedTaskId !== next.id || next.state !== "downloading") {
    speedBytesPerSecond.value = 0;
  }

  trackedTaskId = next.id;
  lastDownloadedBytes = next.downloadedBytes;
  lastSampleAt = now;
  currentTask.value = next;

  if (isTerminal(next.state) && scheduledFinishedTaskId !== next.id) {
    scheduledFinishedTaskId = next.id;
    scheduleDismiss(finishedDismissMs);
  }
}

function togglePanel(): void {
  panelOpen.value = !panelOpen.value;
  clearDismissTimer();
  if (!panelOpen.value && isFinished.value) scheduleDismiss(viewedDismissMs);
}

function closeFromOutside(event: PointerEvent): void {
  if (!panelOpen.value || root.value?.contains(event.target as Node)) return;
  panelOpen.value = false;
  if (isFinished.value) scheduleDismiss(viewedDismissMs);
}

async function cancelTask(): Promise<void> {
  const task = currentTask.value;
  if (!task || !isActive.value) return;
  await window.seashard.fileDownloads.cancel(task.id);
  await refreshTasks();
}

function scheduleDismiss(delay: number): void {
  clearDismissTimer();
  dismissTimer = setTimeout(() => {
    const task = currentTask.value;
    if (!task || !isTerminal(task.state)) return;
    hiddenTaskIds.add(task.id);
    currentTask.value = undefined;
    panelOpen.value = false;
    resetSpeedSample();
  }, delay);
}

function clearDismissTimer(): void {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  dismissTimer = undefined;
}

function resetSpeedSample(): void {
  trackedTaskId = undefined;
  lastDownloadedBytes = 0;
  lastSampleAt = 0;
  speedBytesPerSecond.value = 0;
  scheduledFinishedTaskId = undefined;
}

/** 胶囊宽度会随任务状态收缩；ResizeObserver 让外围 SVG 始终贴合真实边界。 */
function bindRingObserver(): void {
  ringObserver?.disconnect();
  ringObserver = undefined;
  if (!root.value) {
    ringSize.width = 0;
    ringSize.height = 0;
    return;
  }
  ringObserver = new ResizeObserver(measureRing);
  ringObserver.observe(root.value);
  measureRing();
}

function measureRing(): void {
  if (!root.value) return;
  // SVG 与胶囊等大，矩形再向内缩 1px；2px 描边因此恰好覆盖胶囊外边界。
  ringSize.width = root.value.offsetWidth;
  ringSize.height = root.value.offsetHeight;
}

function clampProgress(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function isTerminal(state: FileDownloadTaskSnapshot["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
</script>

<template>
  <Transition name="download-pill">
    <div v-if="currentTask" ref="root" class="download-task-pill" :class="taskClass">
      <svg
        class="download-task-ring"
        :width="ringSize.width"
        :height="ringSize.height"
        aria-hidden="true"
      >
        <rect
          class="download-task-ring-track"
          x="1"
          y="1"
          :width="Math.max(0, ringSize.width - 2)"
          :height="Math.max(0, ringSize.height - 2)"
          :rx="ringRadius"
          :ry="ringRadius"
          pathLength="100"
        />
        <rect
          class="download-task-ring-value"
          x="1"
          y="1"
          :width="Math.max(0, ringSize.width - 2)"
          :height="Math.max(0, ringSize.height - 2)"
          :rx="ringRadius"
          :ry="ringRadius"
          pathLength="100"
          stroke-dasharray="100"
          :stroke-dashoffset="100 - progress"
        />
      </svg>
      <button
        type="button"
        class="download-task-summary"
        :aria-expanded="panelOpen"
        :aria-label="`${stateLabel}：${fileName}，${Math.round(progress)}%`"
        @click="togglePanel"
      >
        <span class="download-task-badge">
          <component :is="statusIcon" :size="13" :stroke-width="2.2" />
          <span>{{ Math.round(progress) }}%</span>
        </span>
        <span class="download-task-name">{{ isFinished ? stateLabel : fileName }}</span>
      </button>

      <Transition name="download-panel">
        <section v-if="panelOpen" class="download-task-panel" aria-label="下载任务详情">
          <div class="download-panel-heading">
            <div>
              <strong :title="fileName">{{ fileName }}</strong>
              <span>{{ stateLabel }}</span>
            </div>
            <button type="button" aria-label="收起下载详情" @click="togglePanel">
              <X :size="15" />
            </button>
          </div>

          <div class="download-panel-progress">
            <span :style="{ width: `${progress}%` }"></span>
          </div>

          <dl class="download-panel-stats">
            <div>
              <dt>进度</dt>
              <dd>{{ progress.toFixed(1) }}%</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{{ downloadedSize }} / {{ totalSize }}</dd>
            </div>
            <div v-if="isActive">
              <dt>速度</dt>
              <dd>{{ speedText }}</dd>
            </div>
            <div>
              <dt>连接数</dt>
              <dd>{{ currentTask.connections || "正在探测" }}</dd>
            </div>
            <div class="download-path-row">
              <dt>保存位置</dt>
              <dd :title="currentTask.destinationPath">{{ currentTask.destinationPath }}</dd>
            </div>
            <div v-if="currentTask.error" class="download-error-row">
              <dt>结果</dt>
              <dd>{{ currentTask.error }}</dd>
            </div>
          </dl>

          <button v-if="isActive" type="button" class="download-cancel-button" @click="cancelTask">
            取消下载
          </button>
        </section>
      </Transition>
    </div>
  </Transition>
</template>

<style scoped src="./DownloadTaskPill.css"></style>
