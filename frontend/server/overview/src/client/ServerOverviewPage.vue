<script setup lang="ts">
import {
  formatServerCoreType,
  type ServerInstanceClientService,
  type ServerInstanceContentCounts,
  type ServerInstanceSnapshot,
  type ServerRuntimeClientService,
  type ServerRuntimeSnapshot,
} from "@seashard/contracts";
import { Cmz_Button, useToast } from "cmzya-modern-ui";
import {
  Activity,
  CalendarDays,
  Clock3,
  FileArchive,
  Folder,
  FolderOpen,
  HardDrive,
  History,
  Plug,
  Puzzle,
  Server,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { formatRuntimeDuration } from "@seashard/server-ui-shared/runtime-duration";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();
const toast = useToast();
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
const contentCounts = ref<ServerInstanceContentCounts>();
const loading = ref(true);
const instancesError = ref<string>();
const runtimeError = ref<string>();
const openingFolder = ref(false);
const currentTime = ref(Date.now());
let instanceRequestId = 0;
let runtimeRequestId = 0;
let contentCountsRequestId = 0;
let runtimeRefreshTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let instanceProjectionRefreshNeeded = false;

const selectedInstanceId = computed(() => props.selection.instanceId);
const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === selectedInstanceId.value),
);
const iconSource = computed(() => selectedInstance.value?.iconUrl);
const currentState = computed(() => runtimeSnapshot.value?.state ?? "stopped");
const serverActive = computed(() => isActiveRuntimeState(currentState.value));
const runtimeStatus = computed(() =>
  runtimeError.value && !runtimeSnapshot.value ? "状态未知" : runtimeStateLabel(currentState.value),
);
const cumulativeRuntime = computed(() => {
  const persistedRuntime = selectedInstance.value?.totalRuntimeMs ?? 0;
  if (!serverActive.value || !runtimeSnapshot.value?.startedAt) {
    return formatRuntimeDuration(persistedRuntime);
  }
  const startedAt = Date.parse(runtimeSnapshot.value.startedAt);
  if (!Number.isFinite(startedAt)) return formatRuntimeDuration(persistedRuntime);
  return formatRuntimeDuration(persistedRuntime + Math.max(0, currentTime.value - startedAt));
});
const lastStartedAt = computed(
  () => runtimeSnapshot.value?.startedAt ?? selectedInstance.value?.lastStartedAt,
);
const coreTypeLabel = computed(() => {
  const serverType = selectedInstance.value?.serverType;
  return serverType ? formatServerCoreType(serverType) : "未知核心";
});
const formattedLastStartedAt = computed(() => formatDateTime(lastStartedAt.value, "尚未启动"));
const formattedCreatedAt = computed(() => formatDateTime(selectedInstance.value?.createdAt));

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
    contentCounts.value = undefined;
    instanceProjectionRefreshNeeded = false;
    if (!registeredInstances.value.some((instance) => instance.id === instanceId)) {
      void loadInstances();
      return;
    }
    void Promise.all([refreshRuntime(), refreshContentCounts()]);
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
    await Promise.all([refreshRuntime(), refreshContentCounts()]);
  } catch (error) {
    if (requestId === instanceRequestId) instancesError.value = errorMessage(error);
  } finally {
    if (requestId === instanceRequestId) loading.value = false;
  }
}

/** 两秒轮询当前实例的进程快照；进程退出后重读实例投影以取得已落盘的累计时长。 */
async function refreshRuntime(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    runtimeSnapshot.value = undefined;
    return;
  }
  const requestId = ++runtimeRequestId;
  const wasActive = isActiveRuntimeState(runtimeSnapshot.value?.state);
  try {
    const snapshot = await props.runtime.get(instanceId);
    if (requestId !== runtimeRequestId || instanceId !== selectedInstanceId.value) return;
    runtimeSnapshot.value = snapshot;
    if (
      (wasActive && !isActiveRuntimeState(snapshot.state)) ||
      instanceProjectionNeedsRefresh(snapshot, selectedInstance.value)
    ) {
      instanceProjectionRefreshNeeded = true;
    }
    if (instanceProjectionRefreshNeeded) {
      const instances = await props.instances.list();
      if (requestId !== runtimeRequestId || instanceId !== selectedInstanceId.value) return;
      registeredInstances.value = instances;
      instanceProjectionRefreshNeeded = false;
    }
    runtimeError.value = undefined;
  } catch (error) {
    if (requestId === runtimeRequestId && instanceId === selectedInstanceId.value) {
      runtimeError.value = errorMessage(error);
    }
  }
}

/** 数量统计由 Host 限定在当前已登记实例目录，Renderer 不读取本地文件系统。 */
async function refreshContentCounts(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    contentCounts.value = undefined;
    return;
  }
  const requestId = ++contentCountsRequestId;
  try {
    const counts = await props.instances.contentCounts(instanceId);
    if (requestId !== contentCountsRequestId || instanceId !== selectedInstanceId.value) return;
    contentCounts.value = counts;
  } catch (error) {
    if (requestId !== contentCountsRequestId || instanceId !== selectedInstanceId.value) return;
    contentCounts.value = undefined;
    console.error("服务器内容数量读取失败", error);
  }
}
/** Renderer 只提交实例 ID；Host 会重新查询登记目录后再调用系统文件管理器。 */
async function openSelectedInstanceFolder(): Promise<void> {
  const instance = selectedInstance.value;
  if (!instance || openingFolder.value || !("openFolder" in props.instances)) return;
  openingFolder.value = true;
  try {
    await props.instances.openFolder(instance.id);
  } catch (error) {
    toast.error({ title: "打开文件夹失败", description: errorMessage(error) });
  } finally {
    openingFolder.value = false;
  }
}

function runtimeStateLabel(state: ServerRuntimeSnapshot["state"]): string {
  if (state === "starting") return "正在启动";
  if (state === "running") return "运行中";
  if (state === "stopping") return "正在停止";
  if (state === "failed") return "异常退出";
  return "已停止";
}

function isActiveRuntimeState(state: ServerRuntimeSnapshot["state"] | undefined): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

function instanceProjectionNeedsRefresh(
  runtime: ServerRuntimeSnapshot,
  instance: ServerInstanceSnapshot | undefined,
): boolean {
  if (!runtime.stoppedAt || !instance) return false;
  const stoppedAt = Date.parse(runtime.stoppedAt);
  const updatedAt = Date.parse(instance.updatedAt);
  return Number.isFinite(stoppedAt) && (!Number.isFinite(updatedAt) || updatedAt < stoppedAt);
}

function formatDateTime(value: string | undefined, fallback = "—"): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return fallback;
  return dateTimeFormatter.format(timestamp);
}

function storageModeLabel(instance: ServerInstanceSnapshot): string {
  return instance.storageMode === "managed" ? "SeaShard 本地托管" : "外部目录";
}

function sourceLabel(instance: ServerInstanceSnapshot): string {
  return instance.source === "downloaded" ? "核心下载创建" : "本地导入";
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
  <section class="server-overview-page" aria-label="服务器信息页面">
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
      <div class="overview-sidebar">
        <aside class="server-identity-panel">
          <div class="overview-server-icon" :style="instanceStyle(selectedInstance)">
            <img v-if="iconSource" :src="iconSource" alt="" draggable="false" />
            <span v-else>{{ instanceMark(selectedInstance) }}</span>
          </div>
          <div class="server-identity-copy">
            <h1>{{ selectedInstance.name }}</h1>
            <div class="identity-tags" aria-label="服务器核心信息">
              <span class="identity-tag">{{ coreTypeLabel }}</span>
              <span class="identity-tag">
                MC {{ selectedInstance.gameVersion ?? "未知版本" }}
              </span>
            </div>
          </div>
        </aside>

        <section class="statistics-list" aria-label="服务器统计">
          <article class="statistic-row">
            <span class="statistic-label">
              <Activity :size="16" :stroke-width="1.8" />
              运行状态
            </span>
            <strong>{{ runtimeStatus }}</strong>
          </article>
          <article class="statistic-row">
            <span class="statistic-label">
              <Clock3 :size="16" :stroke-width="1.8" />
              累计运行时长
            </span>
            <strong>{{ cumulativeRuntime }}</strong>
          </article>
          <article class="statistic-row">
            <span class="statistic-label">
              <History :size="16" :stroke-width="1.8" />
              最后启动时间
            </span>
            <strong>{{ formattedLastStartedAt }}</strong>
          </article>
          <article class="statistic-row">
            <span class="statistic-label">
              <CalendarDays :size="16" :stroke-width="1.8" />
              创建时间
            </span>
            <strong>{{ formattedCreatedAt }}</strong>
          </article>
          <p v-if="runtimeError" class="runtime-read-warning" role="alert">{{ runtimeError }}</p>
        </section>
      </div>

      <main class="overview-content">
        <section class="server-information-panel" aria-labelledby="server-information-title">
          <div class="information-heading">
            <h2 id="server-information-title">服务器信息</h2>
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
              <dt><HardDrive :size="16" />存储方式</dt>
              <dd>{{ storageModeLabel(selectedInstance) }}</dd>
            </div>
            <div class="information-item">
              <dt><History :size="16" />实例来源</dt>
              <dd>{{ sourceLabel(selectedInstance) }}</dd>
            </div>
            <div class="information-item information-item--path">
              <dt><Folder :size="16" />本地文件夹</dt>
              <dd class="folder-path-value">
                <span>{{ selectedInstance.rootPath }}</span>
                <template v-if="'openFolder' in instances">
                  <Cmz_Button
                    variant="outline"
                    size="sm"
                    :loading="openingFolder"
                    @click="openSelectedInstanceFolder"
                  >
                    <FolderOpen :size="14" />
                    打开
                  </Cmz_Button>
                </template>
              </dd>
            </div>
          </dl>
        </section>

        <section class="content-counts-panel" aria-label="服务器内容数量">
          <article class="content-count-item">
            <span class="content-count-icon"><Puzzle :size="18" :stroke-width="1.8" /></span>
            <span>模组数量</span>
            <strong>{{ contentCounts?.mods ?? "—" }}</strong>
          </article>
          <article class="content-count-item">
            <span class="content-count-icon"><Plug :size="18" :stroke-width="1.8" /></span>
            <span>插件数量</span>
            <strong>{{ contentCounts?.plugins ?? "—" }}</strong>
          </article>
        </section>
      </main>
    </div>
  </section>
</template>

<style scoped src="./ServerOverviewPage.css"></style>
