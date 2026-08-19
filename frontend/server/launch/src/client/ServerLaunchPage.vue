<script setup lang="ts">
import { isServerRuntimeSupportedType } from "@seashard/contracts";
import type {
  ServerInstanceClientService,
  ServerInstanceSnapshot,
  ServerRuntimeClientService,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Modal } from "cmzya-modern-ui";
import {
  AlertTriangle,
  Check,
  FileCog,
  ImagePlus,
  Play,
  Power,
  Rows3,
  Server,
  Trash2,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ServerInstanceSelection } from "./server-selection";
import { runtimeErrorMessage } from "./runtime-error";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();

const route = useRoute();
const router = useRouter();

const pageRoot = ref<HTMLElement>();
const iconInput = ref<HTMLInputElement>();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const selectorOpen = ref(false);
const instancesLoading = ref(true);
const instancesError = ref<string>();
const runtimeError = ref<string>();
const runtimeSnapshots = reactive(new Map<string, ServerRuntimeSnapshot>());
const pendingRuntimeOperations = reactive(new Set<string>());
const customIconSources = reactive(new Map<string, string>());
const iconMenu = reactive({ open: false, x: 0, y: 0 });
const instanceMenu = reactive({
  open: false,
  x: 0,
  y: 0,
  instanceId: undefined as string | undefined,
});
const deleteTarget = ref<ServerInstanceSnapshot>();
const deleteConfirmOpen = ref(false);
const deletingInstanceId = ref<string>();
const deleteError = ref<string>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let listRequestId = 0;
let pendingInstanceId =
  typeof route.query.instance === "string" && route.query.instance
    ? route.query.instance
    : undefined;

const selectedInstanceId = computed<string | undefined>({
  get: () => props.selection.instanceId,
  set: (instanceId) => {
    props.selection.instanceId = instanceId;
  },
});
const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === selectedInstanceId.value),
);
const selectedRuntime = computed(() => {
  const instanceId = selectedInstance.value?.id;
  return instanceId ? runtimeSnapshots.get(instanceId) : undefined;
});
const selectedIconSource = computed(() => {
  const instance = selectedInstance.value;
  return instance ? (customIconSources.get(instance.id) ?? instance.iconUrl) : undefined;
});
const deleteTargetFolderPath = computed(() => deleteTarget.value?.rootPath ?? "");
const selectedServerActive = computed(
  () => selectedRuntime.value?.state === "running" || selectedRuntime.value?.state === "stopping",
);
const selectedServerSupported = computed(() =>
  isServerRuntimeSupportedType(selectedInstance.value?.serverType),
);
const runtimeOperationPending = computed(() => {
  const instanceId = selectedInstance.value?.id;
  const state = selectedRuntime.value?.state;
  return (
    (instanceId !== undefined && pendingRuntimeOperations.has(instanceId)) ||
    state === "starting" ||
    state === "stopping"
  );
});
const primaryLabel = computed(() => {
  if (!selectedServerSupported.value) return "暂不支持此核心";
  if (selectedRuntime.value?.state === "starting") return "正在启动";
  if (selectedRuntime.value?.state === "stopping") return "正在停止";
  return selectedRuntime.value?.state === "running" ? "停止服务器" : "启动服务器";
});
const primaryIcon = computed(() => (selectedServerActive.value ? Power : Play));
const sortedInstances = computed(() =>
  [...registeredInstances.value].sort(
    (left, right) => Number(isInstanceActive(right.id)) - Number(isInstanceActive(left.id)),
  ),
);

onMounted(() => {
  document.addEventListener("pointerdown", closeContextMenus);
  document.addEventListener("keydown", handleDocumentKeydown);
  void loadInstances();
  refreshTimer = setInterval(() => void loadInstances(true), 2_000);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeContextMenus);
  document.removeEventListener("keydown", handleDocumentKeydown);
  clearInterval(refreshTimer);
});

/** 定时刷新实例与真实进程状态，不用 Renderer 内的临时集合伪造运行状态。 */
async function loadInstances(silent = false): Promise<void> {
  const requestId = ++listRequestId;
  if (!silent) instancesLoading.value = true;
  try {
    const result = await props.instances.list();
    const runtimeResults = await Promise.allSettled(
      result.map(async (instance) => ({
        instanceId: instance.id,
        snapshot: await props.runtime.get(instance.id),
      })),
    );
    if (requestId !== listRequestId) return;

    registeredInstances.value = result;
    instancesError.value = undefined;
    const currentIds = new Set(result.map((instance) => instance.id));
    for (const instanceId of runtimeSnapshots.keys()) {
      if (!currentIds.has(instanceId)) runtimeSnapshots.delete(instanceId);
    }
    let readError: string | undefined;
    for (const runtimeResult of runtimeResults) {
      if (runtimeResult.status === "fulfilled") {
        runtimeSnapshots.set(runtimeResult.value.instanceId, runtimeResult.value.snapshot);
      } else {
        readError ??= errorMessage(runtimeResult.reason);
      }
    }
    runtimeError.value = readError;

    const requestedInstance = pendingInstanceId
      ? result.find(({ id }) => id === pendingInstanceId)
      : undefined;
    if (requestedInstance) {
      selectedInstanceId.value = requestedInstance.id;
      pendingInstanceId = undefined;
    } else if (
      !selectedInstanceId.value ||
      !result.some((instance) => instance.id === selectedInstanceId.value)
    ) {
      selectedInstanceId.value = result[0]?.id;
    }
    if (result.length === 0) selectorOpen.value = false;
  } catch (error) {
    if (requestId === listRequestId) instancesError.value = errorMessage(error);
  } finally {
    if (requestId === listRequestId) instancesLoading.value = false;
  }
}

/** 只调用 Contract 共享列表中明确实现的核心；这里不扫描产物或猜测类型。 */
async function toggleServer(): Promise<void> {
  const instance = selectedInstance.value;
  if (
    !instance ||
    !isServerRuntimeSupportedType(instance.serverType) ||
    runtimeOperationPending.value
  ) {
    return;
  }

  pendingRuntimeOperations.add(instance.id);
  runtimeError.value = undefined;
  try {
    const snapshot =
      runtimeSnapshots.get(instance.id)?.state === "running"
        ? await props.runtime.stop(instance.id)
        : await props.runtime.start(instance.id);
    runtimeSnapshots.set(instance.id, snapshot);
  } catch (error) {
    runtimeError.value = runtimeErrorMessage(error);
    const snapshot = await props.runtime.get(instance.id).catch(() => undefined);
    if (snapshot) runtimeSnapshots.set(instance.id, snapshot);
  } finally {
    pendingRuntimeOperations.delete(instance.id);
  }
}

function toggleSelector(): void {
  if (registeredInstances.value.length === 0) return;
  selectorOpen.value = !selectorOpen.value;
  iconMenu.open = false;
  instanceMenu.open = false;
}

function selectInstance(instanceId: string): void {
  selectedInstanceId.value = instanceId;
  runtimeError.value = undefined;
  iconMenu.open = false;
  instanceMenu.open = false;
}

function openConfiguration(): void {
  void router.push("/server/configuration");
}
/** 菜单坐标限制在页面内部，图标移动到左半区后右键菜单仍从指针位置出现。 */
function openIconMenu(event: MouseEvent): void {
  if (!selectedInstance.value) return;
  instanceMenu.open = false;
  const root = pageRoot.value;
  if (!root) return;
  const bounds = root.getBoundingClientRect();
  const menuWidth = 148;
  const menuHeight = 42;
  iconMenu.x = clamp(event.clientX - bounds.left, 8, bounds.width - menuWidth - 8);
  iconMenu.y = clamp(event.clientY - bounds.top, 8, bounds.height - menuHeight - 8);
  iconMenu.open = true;
}

function openIconMenuFromKeyboard(): void {
  instanceMenu.open = false;
  const root = pageRoot.value;
  const icon = root?.querySelector<HTMLElement>(".instance-icon-button");
  if (!root || !icon) return;
  const rootBounds = root.getBoundingClientRect();
  const iconBounds = icon.getBoundingClientRect();
  iconMenu.x = iconBounds.right - rootBounds.left - 24;
  iconMenu.y = iconBounds.bottom - rootBounds.top - 8;
  iconMenu.open = true;
}

function closeContextMenus(): void {
  iconMenu.open = false;
  instanceMenu.open = false;
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeContextMenus();
    selectorOpen.value = false;
  }
}

function chooseCustomIcon(): void {
  iconMenu.open = false;
  iconInput.value?.click();
}

/** 实例右键菜单绑定被点击的行，不隐式切换当前选中实例。 */
function openInstanceMenu(event: MouseEvent, instance: ServerInstanceSnapshot): void {
  const root = pageRoot.value;
  if (!root) return;
  const bounds = root.getBoundingClientRect();
  const menuWidth = 148;
  const menuHeight = 42;
  iconMenu.open = false;
  instanceMenu.instanceId = instance.id;
  instanceMenu.x = clamp(event.clientX - bounds.left, 8, bounds.width - menuWidth - 8);
  instanceMenu.y = clamp(event.clientY - bounds.top, 8, bounds.height - menuHeight - 8);
  instanceMenu.open = true;
}

function openInstanceMenuFromKeyboard(
  event: KeyboardEvent,
  instance: ServerInstanceSnapshot,
): void {
  const root = pageRoot.value;
  const row = event.currentTarget as HTMLElement | null;
  if (!root || !row) return;
  const rootBounds = root.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  openInstanceMenu(
    new MouseEvent("contextmenu", {
      clientX: rowBounds.right - 16,
      clientY: rowBounds.top + rowBounds.height / 2,
    }),
    instance,
  );
  instanceMenu.x = clamp(instanceMenu.x, 8, rootBounds.width - 156);
}

function requestDeleteInstance(): void {
  const instance = registeredInstances.value.find(({ id }) => id === instanceMenu.instanceId);
  instanceMenu.open = false;
  if (!instance) return;
  if (isInstanceActive(instance.id)) {
    runtimeError.value = "请先停止服务器，再删除实例";
    return;
  }
  deleteTarget.value = instance;
  deleteError.value = undefined;
  deleteConfirmOpen.value = true;
}

function setDeleteConfirmVisible(visible: boolean): void {
  if (visible) {
    deleteConfirmOpen.value = true;
  } else if (!deletingInstanceId.value) {
    deleteConfirmOpen.value = false;
    deleteTarget.value = undefined;
    deleteError.value = undefined;
  }
}

/** Host 成功删除目录和 SQLite 记录后，立即切换到相邻实例并重新读取真实列表。 */
async function confirmDeleteInstance(): Promise<void> {
  const instance = deleteTarget.value;
  if (!instance || deletingInstanceId.value) return;
  deletingInstanceId.value = instance.id;
  deleteError.value = undefined;
  const currentIndex = registeredInstances.value.findIndex(({ id }) => id === instance.id);
  try {
    await props.instances.delete(instance.id);
    const remaining = registeredInstances.value.filter(({ id }) => id !== instance.id);
    registeredInstances.value = remaining;
    runtimeSnapshots.delete(instance.id);
    customIconSources.delete(instance.id);
    if (selectedInstanceId.value === instance.id) {
      selectedInstanceId.value = remaining[Math.min(currentIndex, remaining.length - 1)]?.id;
    }
    deleteConfirmOpen.value = false;
    deleteTarget.value = undefined;
    if (remaining.length === 0) selectorOpen.value = false;
    await loadInstances(true);
  } catch (error) {
    deleteError.value = errorMessage(error);
  } finally {
    deletingInstanceId.value = undefined;
  }
}

/** 当前仅保留会话内预览；实例图标持久化将在实例设置能力接入时交给 Host。 */
async function applyCustomIcon(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  const instance = selectedInstance.value;
  if (!file || !file.type.startsWith("image/") || !instance) return;

  input.value = "";
  const source = await readImageFile(file).catch(() => undefined);
  if (source) customIconSources.set(instance.id, source);
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("custom server icon did not produce an image URL"));
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
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

function isInstanceActive(instanceId: string): boolean {
  const state = runtimeSnapshots.get(instanceId)?.state;
  return state === "starting" || state === "running" || state === "stopping";
}

function instanceStateLabel(instanceId: string): string {
  const state = runtimeSnapshots.get(instanceId)?.state;
  if (state === "starting") return "启动中";
  if (state === "stopping") return "停止中";
  return "运行中";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section
    ref="pageRoot"
    class="server-launch-page"
    :class="{ 'selector-open': selectorOpen }"
    aria-label="服务器启动"
  >
    <div v-if="selectedInstance" class="launch-focus-area">
      <button
        type="button"
        class="instance-icon-button"
        aria-label="服务器核心图标，右键修改图标"
        aria-haspopup="menu"
        @contextmenu.prevent.stop="openIconMenu"
        @keydown.shift.f10.prevent="openIconMenuFromKeyboard"
      >
        <span
          class="instance-icon-visual instance-icon-large"
          :style="instanceStyle(selectedInstance)"
        >
          <img v-if="selectedIconSource" :src="selectedIconSource" alt="" draggable="false" />
          <span v-else>{{ instanceMark(selectedInstance) }}</span>
        </span>
      </button>

      <div class="launch-actions">
        <button
          type="button"
          class="primary-launch-button"
          :class="{ 'is-stop': selectedServerActive }"
          :disabled="!selectedServerSupported || runtimeOperationPending"
          :aria-busy="runtimeOperationPending"
          @click="toggleServer"
        >
          <component :is="primaryIcon" :size="18" :stroke-width="2" />
          <span>{{ primaryLabel }}</span>
        </button>

        <p v-if="runtimeError" class="launch-runtime-error" role="alert">
          {{ runtimeError }}
        </p>

        <div class="secondary-actions">
          <button type="button" class="secondary-launch-button" @click="openConfiguration">
            <FileCog :size="16" :stroke-width="1.8" />
            <span>配置管理</span>
          </button>
          <button
            type="button"
            class="secondary-launch-button"
            :class="{ active: selectorOpen }"
            :aria-pressed="selectorOpen"
            @click="toggleSelector"
          >
            <Rows3 :size="16" :stroke-width="1.8" />
            <span>实例选择</span>
          </button>
        </div>
      </div>
    </div>

    <div v-else class="launch-empty-state" role="status">
      <span class="launch-empty-icon" aria-hidden="true">
        <Server :size="32" :stroke-width="1.55" />
      </span>
      <strong>{{
        instancesLoading
          ? "正在读取服务器实例"
          : instancesError
            ? "无法读取服务器实例"
            : "还没有服务器实例"
      }}</strong>
      <span>{{ instancesError ?? "从下载页面获取服务器核心后，实例会自动显示在这里。" }}</span>
      <button v-if="instancesError" type="button" @click="loadInstances()">重新加载</button>
    </div>

    <aside
      class="instance-selector-panel"
      aria-label="选择实例"
      :aria-hidden="!selectorOpen"
      :inert="!selectorOpen"
    >
      <TransitionGroup
        name="instance-order"
        tag="div"
        class="instance-list"
        role="listbox"
        aria-label="服务器实例"
      >
        <button
          v-for="instance in sortedInstances"
          :key="instance.id"
          type="button"
          class="instance-list-row"
          :class="{ selected: selectedInstanceId === instance.id }"
          role="option"
          :aria-selected="selectedInstanceId === instance.id"
          aria-haspopup="menu"
          @click="selectInstance(instance.id)"
          @contextmenu.prevent.stop="openInstanceMenu($event, instance)"
          @keydown.shift.f10.prevent.stop="openInstanceMenuFromKeyboard($event, instance)"
        >
          <span class="instance-icon-visual instance-icon-small" :style="instanceStyle(instance)">
            <img
              v-if="customIconSources.get(instance.id) ?? instance.iconUrl"
              :src="customIconSources.get(instance.id) ?? instance.iconUrl"
              alt=""
              draggable="false"
            />
            <span v-else>{{ instanceMark(instance) }}</span>
          </span>
          <span class="instance-row-name">{{ instance.name }}</span>
          <span
            v-if="isInstanceActive(instance.id) || selectedInstanceId === instance.id"
            class="instance-row-meta"
          >
            <span v-if="isInstanceActive(instance.id)" class="instance-running-state">
              <span class="instance-running-dot" aria-hidden="true"></span>
              {{ instanceStateLabel(instance.id) }}
            </span>
            <Check
              v-if="selectedInstanceId === instance.id"
              class="instance-selected-check"
              :size="17"
              :stroke-width="2.2"
            />
          </span>
        </button>
      </TransitionGroup>
    </aside>

    <div
      v-if="iconMenu.open"
      class="icon-context-menu"
      role="menu"
      :style="{ left: `${iconMenu.x}px`, top: `${iconMenu.y}px` }"
      @pointerdown.stop
    >
      <button type="button" role="menuitem" @click="chooseCustomIcon">
        <ImagePlus :size="16" :stroke-width="1.8" />
        <span>修改图标</span>
      </button>
    </div>

    <div
      v-if="instanceMenu.open"
      class="instance-context-menu"
      role="menu"
      :style="{ left: `${instanceMenu.x}px`, top: `${instanceMenu.y}px` }"
      @pointerdown.stop
    >
      <button type="button" class="danger" role="menuitem" @click="requestDeleteInstance">
        <Trash2 :size="16" :stroke-width="1.8" />
        <span>删除</span>
      </button>
    </div>

    <input
      ref="iconInput"
      class="visually-hidden-icon-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      aria-hidden="true"
      tabindex="-1"
      @change="applyCustomIcon"
    />

    <Cmz_Modal
      :visible="deleteConfirmOpen && !!deleteTarget"
      title="删除服务器实例"
      width="440px"
      :close-on-overlay="!deletingInstanceId"
      @close="setDeleteConfirmVisible(false)"
      @update:visible="setDeleteConfirmVisible"
    >
      <div class="delete-confirm-content">
        <span class="delete-confirm-icon" aria-hidden="true">
          <AlertTriangle :size="21" />
        </span>
        <div>
          <p>是否确认删除文件夹 [{{ deleteTargetFolderPath }}]？</p>
          <p v-if="deleteError" class="delete-confirm-error" role="alert">{{ deleteError }}</p>
        </div>
      </div>
      <template #footer>
        <div class="delete-modal-actions">
          <Cmz_Button
            variant="outline"
            :disabled="!!deletingInstanceId"
            @click="setDeleteConfirmVisible(false)"
          >
            取消
          </Cmz_Button>
          <Cmz_Button
            color="#ef4444"
            :loading="!!deletingInstanceId"
            @click="confirmDeleteInstance"
          >
            确认删除
          </Cmz_Button>
        </div>
      </template>
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerLaunchPage.css"></style>
