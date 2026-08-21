<script setup lang="ts">
import {
  type ServerInstanceClientService,
  type ServerInstanceSnapshot,
  type ServerRuntimeClientService,
  type ServerRuntimeSnapshot,
  type ServerWorldDimensionGroup,
  type ServerWorldSave,
  type ServerWorldStorageSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Spinner, useToast } from "cmzya-modern-ui";
import { Archive, ChevronDown, RefreshCw, Server } from "lucide-vue-next";
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
const refreshing = ref(false);
const error = ref<string>();
const expandedGroups = ref<Set<string>>(new Set());
const switchingId = ref<string>();
const serverActiveWarning = ref(false);
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
const visibleGroups = computed<readonly ServerWorldDimensionGroup[]>(
  () => storage.value?.dimensions ?? [],
);

onMounted(() => {
  void load();
  runtimeTimer = setInterval(() => void refreshRuntime(), 2_000);
});

onBeforeUnmount(() => clearInterval(runtimeTimer));

watch(
  () => props.selection.instanceId,
  () => {
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
  refreshing.value = true;
  error.value = undefined;
  try {
    const result = await props.instances.listWorldStorage(instanceId);
    if (currentRequestId !== requestId || instanceId !== selectedInstanceId.value) return;
    storage.value = result;
    if (result.mode === "split") {
      expandedGroups.value = new Set(result.dimensions.slice(0, 1).map((group) => group.id));
    }
  } catch (cause) {
    if (currentRequestId === requestId) error.value = errorMessage(cause);
  } finally {
    if (currentRequestId === requestId) refreshing.value = false;
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
    // 运行态读取失败不阻塞存档浏览；切换请求仍由 Host 重新校验。
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

function isExpanded(groupId: string): boolean {
  return expandedGroups.value.has(groupId);
}

function dimensionLabel(dimension: ServerWorldSave["dimension"]): string {
  if (dimension === "nether") return "下界";
  if (dimension === "end") return "末地";
  return "主世界";
}

function runtimeStateLabel(state: ServerRuntimeSnapshot["state"] | undefined): string {
  if (state === "starting") return "正在启动";
  if (state === "running") return "运行中";
  if (state === "stopping") return "正在停止";
  return "已停止";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <section class="server-world-save-page" aria-labelledby="server-world-save-title">
    <header class="world-save-heading">
      <h1 id="server-world-save-title">存档</h1>
      <div class="world-save-toolbar">
        <span v-if="selectedInstance" class="world-save-instance">
          <Server :size="15" :stroke-width="1.8" />
          {{ selectedInstance.name }}
        </span>
        <span v-if="runtimeSnapshot" class="world-save-runtime" :class="{ active: activeRuntime }">
          {{ runtimeStateLabel(runtimeSnapshot.state) }}
        </span>
        <Cmz_Button
          variant="ghost"
          size="sm"
          icon-only
          aria-label="刷新存档列表"
          :loading="refreshing"
          @click="loadStorage"
        >
          <RefreshCw :size="16" :stroke-width="1.8" />
        </Cmz_Button>
      </div>
    </header>

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

    <div v-else-if="storage?.mode === 'unified'" class="world-save-content">
      <div class="world-save-section-heading">
        <h2>普通存档</h2>
        <span>{{ storage.saves.length }} 个存档</span>
      </div>
      <div v-if="storage.saves.length === 0" class="world-save-empty">
        <Archive :size="30" :stroke-width="1.5" />
        <strong>暂未发现存档</strong>
      </div>
      <div v-else class="world-save-grid" aria-label="普通存档列表">
        <button
          v-for="save in storage.saves"
          :key="save.id"
          type="button"
          class="world-save-card"
          :class="{ current: save.current, switching: switchingId === save.id }"
          :aria-current="save.current ? 'page' : undefined"
          :disabled="Boolean(switchingId)"
          @click="selectUnifiedSave(save)"
        >
          <span class="world-save-icon">
            <img v-if="save.iconDataUrl" :src="save.iconDataUrl" alt="" draggable="false" />
            <Archive v-else :size="28" :stroke-width="1.5" />
          </span>
          <span class="world-save-card-copy">
            <strong>{{ save.name }}</strong>
            <span>{{ save.id }}</span>
          </span>
          <span v-if="save.current" class="world-save-current">当前存档</span>
        </button>
      </div>
    </div>

    <div v-else class="world-save-content">
      <div class="world-save-section-heading">
        <h2>分维度存档</h2>
        <span>{{ visibleGroups.length }} 组存档</span>
      </div>
      <div v-if="visibleGroups.length === 0" class="world-save-empty">
        <Archive :size="30" :stroke-width="1.5" />
        <strong>暂未发现存档</strong>
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
            <span class="world-save-group-copy">
              <strong>{{ group.name }}</strong>
              <span>{{ group.saves.length }} 个维度</span>
            </span>
            <span v-if="group.current" class="world-save-current">当前存档</span>
            <ChevronDown
              class="world-save-chevron"
              :class="{ expanded: isExpanded(group.id) }"
              :size="18"
              :stroke-width="1.8"
            />
          </button>
          <div v-if="isExpanded(group.id)" class="world-save-dimension-list">
            <button
              v-for="save in group.saves"
              :key="save.id"
              type="button"
              class="world-save-dimension-row"
              :disabled="Boolean(switchingId)"
              @click="selectDimensionGroup(group)"
            >
              <span class="world-save-icon world-save-icon--small">
                <img v-if="save.iconDataUrl" :src="save.iconDataUrl" alt="" draggable="false" />
                <Archive v-else :size="21" :stroke-width="1.5" />
              </span>
              <span class="world-save-card-copy">
                <strong>{{ dimensionLabel(save.dimension) }}</strong>
                <span>{{ save.name }}</span>
              </span>
              <span v-if="group.current" class="world-save-dimension-current">当前</span>
            </button>
          </div>
        </article>
      </div>
    </div>

    <Cmz_Modal :visible="serverActiveWarning" title="无法切换存档" width="440px">
      <div class="world-save-warning">
        <strong>服务器正在运行</strong>
        <p>需要关停服务器之后才能进行存档切换。</p>
      </div>
      <template #footer>
        <Cmz_Button variant="outline" @click="serverActiveWarning = false">知道了</Cmz_Button>
      </template>
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerWorldSavePage.css"></style>
