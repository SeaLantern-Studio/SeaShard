<script setup lang="ts">
import {
  formatServerCoreType,
  type ServerInstanceClientService,
  type ServerInstanceSnapshot,
  type ServerRuntimeClientService,
  type ServerRuntimeSnapshot,
} from "@seashard/contracts";
import {
  Activity,
  CalendarDays,
  Clock3,
  FileArchive,
  Folder,
  HardDrive,
  History,
  Server,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ServerInstanceSelection } from "./server-selection";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const runtimeSnapshot = ref<ServerRuntimeSnapshot>();
const loading = ref(true);
const instancesError = ref<string>();
const runtimeError = ref<string>();
const currentTime = ref(Date.now());
let instanceRequestId = 0;
let runtimeRequestId = 0;
let runtimeRefreshTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;

const selectedInstanceId = computed(() => props.selection.instanceId);
const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === selectedInstanceId.value),
);
const iconSource = computed(() => selectedInstance.value?.iconUrl);
const currentState = computed(() => runtimeSnapshot.value?.state ?? "stopped");
const serverActive = computed(() =>
  ["starting", "running", "stopping"].includes(currentState.value),
);
const runtimeStatus = computed(() =>
  runtimeError.value && !runtimeSnapshot.value ? "状态未知" : runtimeStateLabel(currentState.value),
);
const runtimeStatusNote = computed(() => {
  if (runtimeSnapshot.value?.pid) return `进程 PID ${runtimeSnapshot.value.pid}`;
  if (runtimeError.value) return "运行状态暂时不可用";
  if (currentState.value === "failed") return runtimeSnapshot.value?.error ?? "服务器进程异常退出";
  return serverActive.value ? "服务器进程正在响应" : "当前没有运行中的进程";
});
const uptime = computed(() => {
  if (!serverActive.value) return "当前未运行";
  if (!runtimeSnapshot.value?.startedAt) return "正在启动";
  const startedAt = Date.parse(runtimeSnapshot.value.startedAt);
  if (!Number.isFinite(startedAt)) return "—";
  return formatDuration(currentTime.value - startedAt);
});
const lastStartedAt = computed(
  () => runtimeSnapshot.value?.startedAt ?? selectedInstance.value?.lastStartedAt,
);
const coreTypeLabel = computed(() => {
  const serverType = selectedInstance.value?.serverType;
  return serverType ? formatServerCoreType(serverType) : "未知核心";
});
const coreFileName = computed(() => {
  const instance = selectedInstance.value;
  return instance?.coreArtifactFileName ?? fileNameFromPath(instance?.coreJarPath);
});
const formattedLastStartedAt = computed(() => formatDateTime(lastStartedAt.value, "尚未启动"));
const formattedCreatedAt = computed(() => formatDateTime(selectedInstance.value?.createdAt));
const runtimeStartedAtNote = computed(() =>
  serverActive.value && runtimeSnapshot.value?.startedAt
    ? `启动于 ${formatDateTime(runtimeSnapshot.value.startedAt)}`
    : "服务器启动后开始统计",
);

onMounted(() => {
  void loadInstances();
  runtimeRefreshTimer = setInterval(() => void refreshRuntime(), 2_000);
  clockTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 1_000);
});

onBeforeUnmount(() => {
  clearInterval(runtimeRefreshTimer);
  clearInterval(clockTimer);
});

watch(
  () => props.selection.instanceId,
  (instanceId, previousInstanceId) => {
    if (instanceId === previousInstanceId || loading.value) return;
    runtimeSnapshot.value = undefined;
    runtimeError.value = undefined;
    if (!registeredInstances.value.some((instance) => instance.id === instanceId)) {
      void loadInstances();
      return;
    }
    void refreshRuntime();
  },
);

/** 概览只读取实例服务发布的稳定投影，不直接访问实例目录或清单文件。 */
async function loadInstances(): Promise<void> {
  const requestId = ++instanceRequestId;
  loading.value = true;
  instancesError.value = undefined;
  try {
    const instances = await props.instances.list();
    if (requestId !== instanceRequestId) return;
    registeredInstances.value = instances;
    const selectedId = instances.some((instance) => instance.id === props.selection.instanceId)
      ? props.selection.instanceId
      : instances[0]?.id;
    props.selection.instanceId = selectedId;
    await refreshRuntime();
  } catch (error) {
    if (requestId === instanceRequestId) instancesError.value = errorMessage(error);
  } finally {
    if (requestId === instanceRequestId) loading.value = false;
  }
}

/** 两秒轮询当前实例的进程快照；切换实例后使用请求编号丢弃迟到响应。 */
async function refreshRuntime(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    runtimeSnapshot.value = undefined;
    return;
  }
  const requestId = ++runtimeRequestId;
  try {
    const snapshot = await props.runtime.get(instanceId);
    if (requestId !== runtimeRequestId || instanceId !== selectedInstanceId.value) return;
    runtimeSnapshot.value = snapshot;
    runtimeError.value = undefined;
  } catch (error) {
    if (requestId === runtimeRequestId && instanceId === selectedInstanceId.value) {
      runtimeError.value = errorMessage(error);
    }
  }
}

function runtimeStateLabel(state: ServerRuntimeSnapshot["state"]): string {
  if (state === "starting") return "正在启动";
  if (state === "running") return "运行中";
  if (state === "stopping") return "正在停止";
  if (state === "failed") return "异常退出";
  return "已停止";
}

function formatDateTime(value: string | undefined, fallback = "—"): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return fallback;
  return dateTimeFormatter.format(timestamp);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function storageModeLabel(instance: ServerInstanceSnapshot): string {
  return instance.storageMode === "managed" ? "SeaShard 托管" : "外部目录";
}

function sourceLabel(instance: ServerInstanceSnapshot): string {
  return instance.source === "downloaded" ? "核心下载创建" : "本地导入";
}

function fileNameFromPath(path: string | undefined): string {
  return path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "—";
}

function instanceStyle(instance: ServerInstanceSnapshot): Record<string, string> {
  return { "--instance-hue": String(instanceHue(instance.id)) };
}

function instanceMark(instance: ServerInstanceSnapshot): string {
  return (instance.serverType ?? instance.name).trim().charAt(0).toUpperCase() || "S";
}

function instanceHue(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % 360;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-overview-page" aria-label="当前服务器信息">
    <div v-if="loading" class="overview-state" role="status">
      <span class="overview-loading-bar" aria-hidden="true"></span>
      <span>正在读取服务器信息</span>
    </div>

    <div v-else-if="instancesError" class="overview-state overview-state--error" role="alert">
      <Server :size="34" :stroke-width="1.5" />
      <strong>无法读取服务器信息</strong>
      <span>{{ instancesError }}</span>
      <button type="button" @click="loadInstances">重新加载</button>
    </div>

    <div v-else-if="!selectedInstance" class="overview-state">
      <Server :size="38" :stroke-width="1.45" />
      <strong>还没有服务器实例</strong>
      <span>从下载页面创建服务器后，这里会显示它的运行统计和基本信息。</span>
    </div>

    <div v-else class="overview-layout">
      <aside class="server-identity-panel">
        <div class="overview-server-icon" :style="instanceStyle(selectedInstance)">
          <img v-if="iconSource" :src="iconSource" alt="" draggable="false" />
          <span v-else>{{ instanceMark(selectedInstance) }}</span>
        </div>
        <div class="server-identity-copy">
          <span class="identity-eyebrow">当前服务器</span>
          <h1>{{ selectedInstance.name }}</h1>
          <p>{{ coreTypeLabel }} · MC {{ selectedInstance.gameVersion ?? "未知版本" }}</p>
        </div>
        <div class="runtime-pill" :class="`runtime-pill--${currentState}`">
          <span aria-hidden="true"></span>
          {{ runtimeStatus }}
        </div>
      </aside>

      <main class="overview-content">
        <section class="statistics-grid" aria-label="服务器统计">
          <article class="statistic-item">
            <div class="statistic-icon"><Activity :size="18" :stroke-width="1.8" /></div>
            <span class="statistic-label">运行状态</span>
            <strong>{{ runtimeStatus }}</strong>
            <small>{{ runtimeStatusNote }}</small>
          </article>
          <article class="statistic-item">
            <div class="statistic-icon"><Clock3 :size="18" :stroke-width="1.8" /></div>
            <span class="statistic-label">本次运行时长</span>
            <strong>{{ uptime }}</strong>
            <small>{{ runtimeStartedAtNote }}</small>
          </article>
          <article class="statistic-item">
            <div class="statistic-icon"><History :size="18" :stroke-width="1.8" /></div>
            <span class="statistic-label">最后启动时间</span>
            <strong>{{ formattedLastStartedAt }}</strong>
            <small>{{ lastStartedAt ? "最近一次进程启动记录" : "暂无启动记录" }}</small>
          </article>
          <article class="statistic-item">
            <div class="statistic-icon"><CalendarDays :size="18" :stroke-width="1.8" /></div>
            <span class="statistic-label">创建时间</span>
            <strong>{{ formattedCreatedAt }}</strong>
            <small>实例首次加入 SeaShard 的时间</small>
          </article>
        </section>

        <section class="server-information-panel" aria-labelledby="server-information-title">
          <div class="information-heading">
            <div>
              <span class="information-kicker">INSTANCE DETAILS</span>
              <h2 id="server-information-title">服务器信息</h2>
            </div>
            <span v-if="runtimeError" class="runtime-read-warning">{{ runtimeError }}</span>
          </div>

          <dl class="information-grid">
            <div class="information-item">
              <dt><Server :size="16" />服务器名称</dt>
              <dd>{{ selectedInstance.name }}</dd>
            </div>
            <div class="information-item">
              <dt><HardDrive :size="16" />Minecraft 版本</dt>
              <dd>{{ selectedInstance.gameVersion ?? "未知" }}</dd>
            </div>
            <div class="information-item">
              <dt><FileArchive :size="16" />核心类型</dt>
              <dd>
                {{ coreTypeLabel }}
                <small v-if="selectedInstance.serverType">{{ selectedInstance.serverType }}</small>
              </dd>
            </div>
            <div class="information-item">
              <dt><FileArchive :size="16" />核心文件</dt>
              <dd>{{ coreFileName }}</dd>
            </div>
            <div class="information-item">
              <dt><HardDrive :size="16" />存储方式</dt>
              <dd>{{ storageModeLabel(selectedInstance) }}</dd>
            </div>
            <div class="information-item">
              <dt><History :size="16" />实例来源</dt>
              <dd>{{ sourceLabel(selectedInstance) }}</dd>
            </div>
            <div class="information-item information-item--path">
              <dt><Folder :size="16" />本地文件夹</dt>
              <dd>{{ selectedInstance.rootPath }}</dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  </section>
</template>

<style scoped src="./ServerOverviewPage.css"></style>
