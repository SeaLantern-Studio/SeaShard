<script setup lang="ts">
import {
  isServerModSource,
  type ServerInstanceClientService,
  type ServerInstanceSnapshot,
  type ServerResourceSourceMetadata,
  type ServerRuntimeClientService,
  type ServerRuntimeSnapshot,
  type ServerWorldBackupSnapshot,
  type ServerWorldDatapackSnapshot,
  type ServerWorldStorageSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Toast, useToast } from "cmzya-modern-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import ServerWorldSaveDetail from "./components/ServerWorldSaveDetail.vue";
import ServerWorldSaveList from "./components/ServerWorldSaveList.vue";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();

const toast = useToast();
const router = useRouter();
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
const dataPacks = ref<readonly ServerWorldDatapackSnapshot[]>([]);
const backupsExpanded = ref(true);
const dataPacksExpanded = ref(true);
const backupLoading = ref(false);
const dataPackLoading = ref(false);
const backupWorkingFile = ref<string>();
const dataPackWorkingFile = ref<string>();
const backupLoadFailed = ref(false);
const dataPackLoadFailed = ref(false);
const restoreTarget = ref<ServerWorldBackupSnapshot>();
const deleteTarget = ref<ServerWorldBackupSnapshot>();
const deleteDataPackTarget = ref<ServerWorldDatapackSnapshot>();
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
    deleteDataPackTarget.value = undefined;
    dataPackWorkingFile.value = undefined;
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
      await Promise.all([loadBackups(detailWorldId.value), loadDataPacks(detailWorldId.value)]);
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
  } catch (cause) {
    const message = errorMessage(cause);
    if (message.includes("关停服务器")) serverActiveWarning.value = true;
    else toast.error({ title: "存档切换失败", description: message });
  } finally {
    switchingId.value = undefined;
  }
}

function addSave(): void {
  toast.info({ title: "添加存档功能尚未开放" });
}

function setRestoreTarget(backup: ServerWorldBackupSnapshot): void {
  restoreTarget.value = backup;
}

function setDeleteTarget(backup: ServerWorldBackupSnapshot): void {
  deleteTarget.value = backup;
}

function setDeleteDataPackTarget(dataPack: ServerWorldDatapackSnapshot): void {
  deleteDataPackTarget.value = dataPack;
}

function openDetails(worldId: string, worldName: string): void {
  detailWorldId.value = worldId;
  detailWorldName.value = worldName;
  viewMode.value = "detail";
  backupsExpanded.value = true;
  dataPacksExpanded.value = true;
  backups.value = [];
  dataPacks.value = [];
  backupLoadFailed.value = false;
  dataPackLoadFailed.value = false;
  deleteDataPackTarget.value = undefined;
  dataPackWorkingFile.value = undefined;
  void Promise.all([loadBackups(worldId), loadDataPacks(worldId)]);
}

function goBack(): void {
  viewMode.value = "list";
  detailWorldId.value = undefined;
  detailWorldName.value = "";
  backupLoadFailed.value = false;
  dataPackLoadFailed.value = false;
  deleteDataPackTarget.value = undefined;
  dataPackWorkingFile.value = undefined;
}
function openResourceSource(
  resourceType: "world" | "datapack",
  metadata: ServerResourceSourceMetadata,
): void {
  if (!isServerModSource(metadata.source)) return;
  void router.push({
    path: resourceType === "world" ? "/server/download/world" : "/server/download/datapack",
    query: { source: metadata.source, id: metadata.id },
  });
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
async function loadDataPacks(worldId = detailWorldId.value): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || !worldId) return;
  dataPackLoading.value = true;
  dataPackLoadFailed.value = false;
  try {
    const result = await props.instances.listWorldDatapacks(instanceId, worldId);
    if (instanceId !== selectedInstanceId.value || worldId !== detailWorldId.value) return;
    dataPacks.value = result;
  } catch (cause) {
    if (instanceId !== selectedInstanceId.value || worldId !== detailWorldId.value) return;
    dataPackLoadFailed.value = true;
    toast.error({ title: "读取数据包失败", description: errorMessage(cause) });
  } finally {
    dataPackLoading.value = false;
  }
}

/** 通过重命名数据包切换启用状态，完成后只更新当前详情列表。 */
async function toggleDataPack(dataPack: ServerWorldDatapackSnapshot): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const worldId = detailWorldId.value;
  if (!instanceId || !worldId || dataPackWorkingFile.value) return;
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return;
  }
  dataPackWorkingFile.value = dataPack.fileName;
  try {
    const updated = await props.instances.setWorldDatapackDisabled(
      instanceId,
      worldId,
      dataPack.fileName,
      !dataPack.disabled,
    );
    if (instanceId !== selectedInstanceId.value || worldId !== detailWorldId.value) return;
    dataPacks.value = dataPacks.value
      .map((candidate) => (candidate.fileName === dataPack.fileName ? updated : candidate))
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.fileName.localeCompare(right.fileName, "zh-CN"),
      );
  } catch (cause) {
    handleDataPackError(cause, dataPack.disabled ? "启用数据包失败" : "禁用数据包失败");
  } finally {
    dataPackWorkingFile.value = undefined;
  }
}

/** 删除确认框确认后，调用 Host 删除实际文件并从当前列表移除。 */
async function deleteDataPack(): Promise<void> {
  const target = deleteDataPackTarget.value;
  const instanceId = selectedInstanceId.value;
  const worldId = detailWorldId.value;
  deleteDataPackTarget.value = undefined;
  if (!target || !instanceId || !worldId || dataPackWorkingFile.value) return;
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return;
  }
  dataPackWorkingFile.value = target.fileName;
  try {
    await props.instances.deleteWorldDatapack(instanceId, worldId, target.fileName);
    if (instanceId !== selectedInstanceId.value || worldId !== detailWorldId.value) return;
    dataPacks.value = dataPacks.value.filter(({ fileName }) => fileName !== target.fileName);
  } catch (cause) {
    handleDataPackError(cause, "删除数据包失败");
  } finally {
    dataPackWorkingFile.value = undefined;
  }
}

function handleDataPackError(cause: unknown, title: string): void {
  const message = errorMessage(cause);
  if (message.includes("关停服务器")) serverActiveWarning.value = true;
  else toast.error({ title, description: message });
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <section class="server-world-save-page" aria-label="存档">
    <Cmz_Toast position="top-right" />
    <ServerWorldSaveDetail
      v-if="viewMode === 'detail'"
      :detail-world-name="detailWorldName"
      :detail-world-id="detailWorldId"
      :detail-save="detailSave"
      :backups="backups"
      :data-packs="dataPacks"
      :backups-expanded="backupsExpanded"
      :data-packs-expanded="dataPacksExpanded"
      :backup-loading="backupLoading"
      :data-pack-loading="dataPackLoading"
      :backup-working-file="backupWorkingFile"
      :data-pack-working-file="dataPackWorkingFile"
      :restore-target="restoreTarget"
      :backup-load-failed="backupLoadFailed"
      :data-pack-load-failed="dataPackLoadFailed"
      @back="goBack"
      @toggle-backups="backupsExpanded = !backupsExpanded"
      @toggle-data-packs="dataPacksExpanded = !dataPacksExpanded"
      @create-backup="createBackup"
      @retry-backups="loadBackups"
      @retry-data-packs="loadDataPacks"
      @restore-backup="setRestoreTarget"
      @delete-backup="setDeleteTarget"
      @toggle-data-pack="toggleDataPack"
      @delete-data-pack="setDeleteDataPackTarget"
      @open-resource-source="openResourceSource"
    />
    <ServerWorldSaveList
      v-else
      :storage="storage"
      :search-query="searchQuery"
      :switching-id="switchingId"
      :can-add="Boolean(selectedInstance)"
      :expanded-groups="expandedGroups"
      :loading="loading"
      :error="error"
      :has-instance="Boolean(selectedInstance)"
      @update:searchQuery="searchQuery = $event"
      @add-save="addSave"
      @retry="load"
      @switch-world="requestSwitch"
      @toggle-group="toggleGroup"
      @open-details="openDetails"
    />

    <Cmz_Modal
      :visible="Boolean(restoreTarget)"
      title="恢复备份"
      width="440px"
      @close="restoreTarget = undefined"
    >
      <div class="world-save-warning">
        <strong>确认恢复此备份？</strong>
        <p>{{ restoreTarget?.fileName }} 将覆盖当前存档目录。</p>
      </div>
      <template #footer
        ><Cmz_Button variant="ghost" @click="restoreTarget = undefined">取消</Cmz_Button
        ><Cmz_Button variant="solid" @click="restoreBackup">恢复</Cmz_Button></template
      >
    </Cmz_Modal>
    <Cmz_Modal
      :visible="Boolean(deleteTarget)"
      title="删除备份"
      width="440px"
      @close="deleteTarget = undefined"
    >
      <div class="world-save-warning">
        <strong>确认删除此备份？</strong>
        <p>{{ deleteTarget?.fileName }} 删除后无法恢复。</p>
      </div>
      <template #footer
        ><Cmz_Button variant="ghost" @click="deleteTarget = undefined">取消</Cmz_Button
        ><Cmz_Button color="var(--sl-error)" @click="deleteBackup">删除</Cmz_Button></template
      >
    </Cmz_Modal>
    <Cmz_Modal
      :visible="Boolean(deleteDataPackTarget)"
      title="删除数据包"
      width="440px"
      @close="deleteDataPackTarget = undefined"
    >
      <div class="world-save-warning">
        <strong>是否删除此数据包？此过程不可恢复</strong>
      </div>
      <template #footer>
        <Cmz_Button variant="ghost" @click="deleteDataPackTarget = undefined">取消</Cmz_Button>
        <Cmz_Button color="var(--sl-error)" @click="deleteDataPack">删除</Cmz_Button>
      </template>
    </Cmz_Modal>
    <Cmz_Modal
      :visible="serverActiveWarning"
      title="无法操作存档"
      width="440px"
      @close="serverActiveWarning = false"
    >
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
