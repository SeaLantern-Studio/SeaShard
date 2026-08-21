<script setup lang="ts">
import {
  type ServerInstanceClientService,
  type ServerInstanceSnapshot,
  type ServerRuntimeClientService,
  type ServerRuntimeSnapshot,
  type ServerWorldBackupSnapshot,
  type ServerWorldDimensionGroup,
  type ServerWorldSave,
  type ServerWorldStorageSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Spinner, useToast } from "cmzya-modern-ui";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Info,
  Plus,
  RotateCcw,
  Search,
  Server,
  Trash2,
} from "lucide-vue-next";
import minecraftDefaultServerIcon from "./assets/minecraft-default-server-icon.png";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();

const toast = useToast();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const storage = ref<ServerWorldStorageSnapshot>();
const runtimeSnapshot = ref<ServerRuntimeSnapshot>();
const loading = ref(true);
const error = ref<string>();
const searchQuery = ref("");
const expandedGroups = ref<Set<string>>(new Set());
const switchingId = ref<string>();
const serverActiveWarning = ref(false);
const viewMode = ref<"list" | "detail">("list");
const detailWorldId = ref<string>();
const detailWorldName = ref("");
const backups = ref<readonly ServerWorldBackupSnapshot[]>([]);
const backupLoading = ref(false);
const backupWorkingFile = ref<string>();
const backupLoadFailed = ref(false);
const restoreTarget = ref<ServerWorldBackupSnapshot>();
const deleteTarget = ref<ServerWorldBackupSnapshot>();
let requestId = 0;
let runtimeTimer: ReturnType<typeof setInterval> | undefined;

const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === props.selection.instanceId),
);
const selectedInstanceId = computed(() => selectedInstance.value?.id);
const activeRuntime = computed(() => {
  const state = runtimeSnapshot.value?.state;
  return state === "starting" || state === "running" || state === "stopping";
});
const visibleSaves = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  const saves = storage.value?.saves ?? [];
  if (!query) return saves;
  return saves.filter((save) => `${save.name} ${save.id}`.toLocaleLowerCase().includes(query));
});
const visibleGroups = computed<readonly ServerWorldDimensionGroup[]>(() => {
  const groups = storage.value?.dimensions ?? [];
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return groups;
  return groups.filter((group) => {
    const groupText = `${group.name} ${group.id} ${group.saves.map((save) => save.name).join(" ")}`;
    return groupText.toLocaleLowerCase().includes(query);
  });
});
const detailSave = computed(() => {
  const id = detailWorldId.value;
  if (!id || !storage.value) return undefined;
  if (storage.value.mode === "unified") return storage.value.saves.find((save) => save.id === id);
  return storage.value.dimensions
    .flatMap((group) => group.saves)
    .find((save) => save.groupId === id || save.id === id);
});

onMounted(() => {
  void load();
  runtimeTimer = setInterval(() => void refreshRuntime(), 2_000);
});

onBeforeUnmount(() => clearInterval(runtimeTimer));

watch(
  () => props.selection.instanceId,
  () => {
    viewMode.value = "list";
    detailWorldId.value = undefined;
    if (!loading.value) void loadStorage();
  },
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    registeredInstances.value = await props.instances.list();
    if (!registeredInstances.value.some((instance) => instance.id === props.selection.instanceId)) {
      props.selection.instanceId = registeredInstances.value[0]?.id;
    }
    await Promise.all([loadStorage(), refreshRuntime()]);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function loadStorage(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    storage.value = undefined;
    return;
  }
  const currentRequestId = ++requestId;
  error.value = undefined;
  try {
    const result = await props.instances.listWorldStorage(instanceId);
    if (currentRequestId !== requestId || instanceId !== selectedInstanceId.value) return;
    storage.value = result;
    if (result.mode === "split") {
      expandedGroups.value = new Set(result.dimensions.slice(0, 1).map((group) => group.id));
    }
    if (viewMode.value === "detail" && detailWorldId.value) {
      await loadBackups(detailWorldId.value);
    }
  } catch (cause) {
    if (currentRequestId === requestId) error.value = errorMessage(cause);
  }
}

async function refreshRuntime(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    runtimeSnapshot.value = undefined;
    return;
  }
  try {
    const snapshot = await props.runtime.get(instanceId);
    if (instanceId === selectedInstanceId.value) runtimeSnapshot.value = snapshot;
  } catch {
    // 运行态读取失败不阻塞存档浏览；具体操作仍由主进程再次校验。
  }
}

function toggleGroup(groupId: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  expandedGroups.value = next;
}

async function selectUnifiedSave(save: ServerWorldSave): Promise<void> {
  await requestSwitch(save.id, save.name);
}

async function selectDimensionGroup(group: ServerWorldDimensionGroup): Promise<void> {
  await requestSwitch(group.id, group.name);
}

async function requestSwitch(worldId: string, worldName: string): Promise<void> {
  const current = storage.value?.currentId;
  if (worldId === current || switchingId.value) return;
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return;
  }
  const instanceId = selectedInstanceId.value;
  if (!instanceId) return;
  switchingId.value = worldId;
  try {
    storage.value = await props.instances.switchWorld(instanceId, worldId);
    toast.success({ title: "存档已切换", description: `当前存档：${worldName}` });
  } catch (cause) {
    const message = errorMessage(cause);
    if (message.includes("关停服务器")) serverActiveWarning.value = true;
    else toast.error({ title: "存档切换失败", description: message });
  } finally {
    switchingId.value = undefined;
  }
}

function openDetails(worldId: string, worldName: string): void {
  detailWorldId.value = worldId;
  detailWorldName.value = worldName;
  viewMode.value = "detail";
  void loadBackups(worldId);
}

function goBack(): void {
  viewMode.value = "list";
  detailWorldId.value = undefined;
  detailWorldName.value = "";
  backupLoadFailed.value = false;
}
async function loadBackups(worldId = detailWorldId.value): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || !worldId) return;
  backupLoading.value = true;
  backupLoadFailed.value = false;
  try {
    backups.value = await props.instances.listWorldBackups(instanceId, worldId);
  } catch (cause) {
    backupLoadFailed.value = true;
    toast.error({ title: "读取备份失败", description: errorMessage(cause) });
  } finally {
    backupLoading.value = false;
  }
}

async function createBackup(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const worldId = detailWorldId.value;
  if (!instanceId || !worldId || backupWorkingFile.value) return;
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return;
  }
  backupWorkingFile.value = "new";
  try {
    await props.instances.createWorldBackup(instanceId, worldId);
    await loadBackups(worldId);
    toast.success({ title: "备份已创建", description: detailWorldName.value });
  } catch (cause) {
    handleBackupError(cause, "创建备份失败");
  } finally {
    backupWorkingFile.value = undefined;
  }
}

async function restoreBackup(): Promise<void> {
  const target = restoreTarget.value;
  const instanceId = selectedInstanceId.value;
  const worldId = detailWorldId.value;
  restoreTarget.value = undefined;
  if (!target || !instanceId || !worldId) return;
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return;
  }
  backupWorkingFile.value = target.fileName;
  try {
    storage.value = await props.instances.restoreWorldBackup(instanceId, worldId, target.fileName);
    await loadBackups(worldId);
    toast.success({ title: "存档已恢复", description: target.fileName });
  } catch (cause) {
    handleBackupError(cause, "恢复备份失败");
  } finally {
    backupWorkingFile.value = undefined;
  }
}

async function deleteBackup(): Promise<void> {
  const target = deleteTarget.value;
  const instanceId = selectedInstanceId.value;
  const worldId = detailWorldId.value;
  deleteTarget.value = undefined;
  if (!target || !instanceId || !worldId) return;
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return;
  }
  backupWorkingFile.value = target.fileName;
  try {
    await props.instances.deleteWorldBackup(instanceId, worldId, target.fileName);
    await loadBackups(worldId);
    toast.success({ title: "备份已删除", description: target.fileName });
  } catch (cause) {
    handleBackupError(cause, "删除备份失败");
  } finally {
    backupWorkingFile.value = undefined;
  }
}

function handleBackupError(cause: unknown, title: string): void {
  const message = errorMessage(cause);
  if (message.includes("关停服务器")) serverActiveWarning.value = true;
  else toast.error({ title, description: message });
}

function isExpanded(groupId: string): boolean {
  return expandedGroups.value.has(groupId);
}

function dimensionLabel(dimension: ServerWorldSave["dimension"]): string {
  if (dimension === "nether") return "下界";
  if (dimension === "end") return "末地";
  return "主世界";
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "—";
}

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <section class="server-world-save-page" aria-label="存档">
    <header v-if="viewMode === 'detail'" class="world-save-heading">
      <div class="world-save-heading-main">
        <Cmz_Button variant="ghost" size="sm" icon-only aria-label="返回存档列表" @click="goBack">
          <ArrowLeft :size="18" :stroke-width="1.8" />
        </Cmz_Button>
        <h1 id="server-world-save-title">{{ detailWorldName }}</h1>
      </div>
    </header>

    <div v-if="viewMode === 'list'" class="world-save-list-toolbar">
      <div class="world-save-search">
        <Search :size="17" :stroke-width="1.8" />
        <input v-model="searchQuery" type="search" placeholder="搜索存档" aria-label="搜索存档" />
      </div>
      <Cmz_Button
        variant="outline"
        size="sm"
        class="world-save-add-button"
        :disabled="!selectedInstance"
        @click="toast.info({ title: '添加存档功能尚未开放' })"
      >
        <Plus :size="16" :stroke-width="1.8" />
        添加
      </Cmz_Button>
    </div>

    <div v-if="loading" class="world-save-state" role="status">
      <Cmz_Spinner size="lg" />
      <span>正在读取存档</span>
    </div>
    <div v-else-if="error" class="world-save-state world-save-state--error" role="alert">
      <Archive :size="34" :stroke-width="1.5" />
      <strong>无法读取存档</strong>
      <span>{{ error }}</span>
      <Cmz_Button variant="outline" size="sm" @click="load">重新加载</Cmz_Button>
    </div>
    <div v-else-if="!selectedInstance" class="world-save-state">
      <Server :size="36" :stroke-width="1.5" />
      <strong>还没有服务器实例</strong>
    </div>

    <template v-else-if="viewMode === 'list'">
      <div v-if="storage?.mode === 'unified'" class="world-save-content">
        <div class="world-save-section-heading">
          <h2>普通存档</h2>
          <span>{{ visibleSaves.length }} 个存档</span>
        </div>
        <div v-if="visibleSaves.length === 0" class="world-save-empty">
          <Archive :size="30" :stroke-width="1.5" />
          <strong>{{ searchQuery ? "没有匹配的存档" : "暂未发现存档" }}</strong>
        </div>
        <div v-else class="world-save-grid" aria-label="普通存档列表">
          <article
            v-for="save in visibleSaves"
            :key="save.id"
            class="world-save-card"
            :class="{ current: save.current, switching: switchingId === save.id }"
          >
            <button
              type="button"
              class="world-save-card-main"
              :disabled="Boolean(switchingId)"
              @click="selectUnifiedSave(save)"
            >
              <span class="world-save-icon">
                <img v-if="save.iconDataUrl" :src="save.iconDataUrl" alt="" draggable="false" />
                <img v-else :src="minecraftDefaultServerIcon" alt="" draggable="false" />
              </span>
              <span class="world-save-card-copy">
                <strong>{{ save.name }}</strong>
                <span class="world-save-meta">
                  <span>{{ save.id }}</span>
                  <small
                    >创建 {{ formatDate(save.createdAt) }}　更新
                    {{ formatDate(save.updatedAt) }}</small
                  >
                </span>
              </span>
            </button>
            <span v-if="save.current" class="world-save-current-label">当前</span>
            <span class="world-save-info">
              <Cmz_Button
                variant="outline"
                size="sm"
                icon-only
                aria-label="查看存档详情"
                @click="openDetails(save.id, save.name)"
              >
                <Info :size="17" :stroke-width="1.8" />
              </Cmz_Button>
            </span>
          </article>
        </div>
      </div>
      <div v-else class="world-save-content">
        <div class="world-save-section-heading">
          <h2>分维度存档</h2>
          <span>{{ visibleGroups.length }} 组存档</span>
        </div>
        <div v-if="visibleGroups.length === 0" class="world-save-empty">
          <Archive :size="30" :stroke-width="1.5" />
          <strong>{{ searchQuery ? "没有匹配的存档" : "暂未发现存档" }}</strong>
        </div>
        <div v-else class="world-save-groups" aria-label="分维度存档列表">
          <article
            v-for="group in visibleGroups"
            :key="group.id"
            class="world-save-group"
            :class="{ current: group.current }"
          >
            <button
              type="button"
              class="world-save-group-trigger"
              :aria-expanded="isExpanded(group.id)"
              @click="toggleGroup(group.id)"
            >
              <span class="world-save-group-icon"><Archive :size="19" :stroke-width="1.7" /></span>
              <span class="world-save-group-copy"
                ><strong>{{ group.name }}</strong
                ><span>{{ group.saves.length }} 个维度</span></span
              >
              <ChevronDown
                class="world-save-chevron"
                :class="{ expanded: isExpanded(group.id) }"
                :size="18"
                :stroke-width="1.8"
              />
            </button>
            <div v-if="isExpanded(group.id)" class="world-save-dimension-list">
              <div v-for="save in group.saves" :key="save.id" class="world-save-dimension-row">
                <button
                  type="button"
                  class="world-save-card-main"
                  :disabled="Boolean(switchingId)"
                  @click="selectDimensionGroup(group)"
                >
                  <span class="world-save-icon world-save-icon--small">
                    <img v-if="save.iconDataUrl" :src="save.iconDataUrl" alt="" draggable="false" />
                    <img v-else :src="minecraftDefaultServerIcon" alt="" draggable="false" />
                  </span>
                  <span class="world-save-card-copy">
                    <strong>{{ dimensionLabel(save.dimension) }}</strong>
                    <span class="world-save-meta">
                      <span>{{ save.id }}</span>
                      <small
                        >创建 {{ formatDate(save.createdAt) }}　更新
                        {{ formatDate(save.updatedAt) }}</small
                      >
                    </span>
                  </span>
                </button>
                <span v-if="group.current" class="world-save-current-label">当前</span>
                <span class="world-save-info">
                  <Cmz_Button
                    variant="outline"
                    size="sm"
                    icon-only
                    aria-label="查看存档详情"
                    @click.stop="openDetails(group.id, group.name)"
                  >
                    <Info :size="17" :stroke-width="1.8" />
                  </Cmz_Button>
                </span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </template>

    <div v-else class="world-save-detail">
      <div class="world-save-detail-header">
        <span class="world-save-icon world-save-icon--large">
          <img
            v-if="detailSave?.iconDataUrl"
            :src="detailSave.iconDataUrl"
            alt=""
            draggable="false"
          />
          <img v-else :src="minecraftDefaultServerIcon" alt="" draggable="false" />
        </span>
        <div class="world-save-card-copy">
          <strong>{{ detailWorldName }}</strong>
          <span>{{ detailWorldId }}</span>
          <small v-if="detailSave"
            >创建 {{ formatDate(detailSave.createdAt) }}　更新
            {{ formatDate(detailSave.updatedAt) }}</small
          >
        </div>
        <span v-if="detailSave?.current" class="world-save-current">当前存档</span>
      </div>
      <section class="world-save-backups" aria-labelledby="world-save-backups-title">
        <header class="world-save-section-heading">
          <h2 id="world-save-backups-title">备份</h2>
          <Cmz_Button
            variant="outline"
            size="sm"
            :loading="backupWorkingFile === 'new'"
            :disabled="Boolean(backupWorkingFile)"
            @click="createBackup"
            ><Plus :size="16" :stroke-width="1.8" />新增</Cmz_Button
          >
        </header>
        <div v-if="backupLoading" class="world-save-inline-state">
          <Cmz_Spinner size="sm" />正在读取备份
        </div>
        <div v-else-if="backupLoadFailed" class="world-save-inline-state">
          <Archive :size="18" :stroke-width="1.6" />
          <Cmz_Button variant="outline" size="sm" @click="loadBackups()">重试</Cmz_Button>
        </div>
        <div v-else-if="backups.length === 0" class="world-save-empty world-save-empty--small">
          <Archive :size="28" :stroke-width="1.5" /><strong>暂无备份</strong>
        </div>
        <div v-else class="world-save-backup-list">
          <article v-for="backup in backups" :key="backup.fileName" class="world-save-backup-row">
            <span class="world-save-backup-icon"><Archive :size="19" :stroke-width="1.7" /></span>
            <span class="world-save-card-copy"
              ><strong>{{ backup.fileName }}</strong
              ><span
                >{{ formatDate(backup.createdAt) }}　{{ formatSize(backup.sizeBytes) }}</span
              ></span
            >
            <div class="world-save-backup-actions">
              <Cmz_Button
                variant="ghost"
                size="sm"
                :loading="backupWorkingFile === backup.fileName && restoreTarget === undefined"
                :disabled="Boolean(backupWorkingFile)"
                @click="restoreTarget = backup"
              >
                <RotateCcw :size="15" :stroke-width="1.8" />恢复
              </Cmz_Button>
              <Cmz_Button
                variant="ghost"
                size="sm"
                :disabled="Boolean(backupWorkingFile)"
                @click="deleteTarget = backup"
                ><Trash2 :size="15" :stroke-width="1.8" />删除</Cmz_Button
              >
            </div>
          </article>
        </div>
      </section>
    </div>

    <Cmz_Modal :visible="Boolean(restoreTarget)" title="恢复备份" width="440px">
      <div class="world-save-warning">
        <strong>确认恢复此备份？</strong>
        <p>{{ restoreTarget?.fileName }} 将覆盖当前存档目录。</p>
      </div>
      <template #footer
        ><Cmz_Button variant="ghost" @click="restoreTarget = undefined">取消</Cmz_Button
        ><Cmz_Button variant="solid" @click="restoreBackup">恢复</Cmz_Button></template
      >
    </Cmz_Modal>
    <Cmz_Modal :visible="Boolean(deleteTarget)" title="删除备份" width="440px">
      <div class="world-save-warning">
        <strong>确认删除此备份？</strong>
        <p>{{ deleteTarget?.fileName }} 删除后无法恢复。</p>
      </div>
      <template #footer
        ><Cmz_Button variant="ghost" @click="deleteTarget = undefined">取消</Cmz_Button
        ><Cmz_Button variant="solid" @click="deleteBackup">删除</Cmz_Button></template
      >
    </Cmz_Modal>
    <Cmz_Modal :visible="serverActiveWarning" title="无法操作存档" width="440px">
      <div class="world-save-warning">
        <strong>服务器正在运行</strong>
        <p>需要关停服务器之后才能操作存档。</p>
      </div>
      <template #footer
        ><Cmz_Button variant="outline" @click="serverActiveWarning = false"
          >知道了</Cmz_Button
        ></template
      >
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerWorldSavePage.css"></style>
