<script setup lang="ts">
import {
  isServerModSource,
  type ServerInstanceClientService,
  type ServerInstalledModSnapshot,
  type ServerInstanceSnapshot,
  type ServerResourceSourceMetadata,
  type ServerRuntimeClientService,
  type ServerRuntimeSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Spinner, Cmz_Toast, useToast } from "cmzya-modern-ui";
import { Ban, ExternalLink, Plus, Puzzle, Search, Server, Trash2 } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();

const router = useRouter();
const toast = useToast();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const mods = ref<readonly ServerInstalledModSnapshot[]>([]);
const loading = ref(true);
const error = ref<string>();
const searchQuery = ref("");
const runtimeSnapshot = ref<ServerRuntimeSnapshot>();
const workingPath = ref<string>();
const deleteTarget = ref<ServerInstalledModSnapshot>();
const serverActiveWarning = ref(false);
const failedSourceIcons = ref<ReadonlySet<string>>(new Set());
const failedModIcons = ref<ReadonlySet<string>>(new Set());
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
const visibleMods = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return mods.value;
  return mods.value.filter((mod) =>
    [mod.name, mod.version, mod.description, mod.fileName, mod.relativePath]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
});

onMounted(() => {
  void load();
  runtimeTimer = setInterval(() => void refreshRuntime(), 2_000);
});

onBeforeUnmount(() => clearInterval(runtimeTimer));

watch(
  () => props.selection.instanceId,
  () => {
    if (!loading.value) void loadModsForSelection();
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
    await Promise.all([loadModsForSelection(), refreshRuntime()]);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function loadModsForSelection(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const currentRequestId = ++requestId;
  error.value = undefined;
  if (!instanceId) {
    mods.value = [];
    return;
  }
  try {
    const next = await props.instances.listMods(instanceId);
    if (currentRequestId !== requestId || instanceId !== selectedInstanceId.value) return;
    mods.value = next;
    failedSourceIcons.value = new Set();
    failedModIcons.value = new Set();
  } catch (cause) {
    if (currentRequestId === requestId) {
      error.value = errorMessage(cause);
      mods.value = [];
    }
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
    // 运行态读取失败不阻塞 MOD 浏览；变更操作仍由主进程复核。
  }
}

function retry(): void {
  void load();
}

function addMod(): void {
  void router.push("/server/download/mod");
}

function openResourceSource(mod: ServerInstalledModSnapshot): void {
  const source = mod.resourceSource;
  if (!source || !isServerModSource(source.source)) return;
  void router.push({
    path: "/server/download/mod",
    query: { source: source.source, id: source.id },
  });
}

function canOpenResourceSource(metadata: ServerResourceSourceMetadata | undefined): boolean {
  return !!metadata && isServerModSource(metadata.source);
}

function sourceIconAvailable(mod: ServerInstalledModSnapshot): boolean {
  return Boolean(mod.resourceSource?.iconUrl && !failedSourceIcons.value.has(mod.relativePath));
}

function modIconAvailable(mod: ServerInstalledModSnapshot): boolean {
  return Boolean(mod.iconDataUrl && !failedModIcons.value.has(mod.relativePath));
}

function markSourceIconFailed(relativePath: string): void {
  failedSourceIcons.value = new Set([...failedSourceIcons.value, relativePath]);
}

function markModIconFailed(relativePath: string): void {
  failedModIcons.value = new Set([...failedModIcons.value, relativePath]);
}

async function toggleMod(mod: ServerInstalledModSnapshot): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || workingPath.value) return;
  if (!(await ensureServerStopped())) return;
  workingPath.value = mod.relativePath;
  try {
    const updated = await props.instances.setModDisabled(
      instanceId,
      mod.relativePath,
      !mod.disabled,
    );
    if (instanceId !== selectedInstanceId.value) return;
    mods.value = sortMods(
      mods.value.map((candidate) =>
        candidate.relativePath === mod.relativePath ? updated : candidate,
      ),
    );
  } catch (cause) {
    handleModError(cause, mod.disabled ? "启用 MOD 失败" : "禁用 MOD 失败");
  } finally {
    workingPath.value = undefined;
  }
}

function requestDelete(mod: ServerInstalledModSnapshot): void {
  if (workingPath.value) return;
  deleteTarget.value = mod;
}

async function deleteMod(): Promise<void> {
  const target = deleteTarget.value;
  const instanceId = selectedInstanceId.value;
  deleteTarget.value = undefined;
  if (!target || !instanceId || workingPath.value) return;
  if (!(await ensureServerStopped())) return;
  workingPath.value = target.relativePath;
  try {
    await props.instances.deleteMod(instanceId, target.relativePath);
    if (instanceId === selectedInstanceId.value) {
      mods.value = mods.value.filter(({ relativePath }) => relativePath !== target.relativePath);
    }
  } catch (cause) {
    handleModError(cause, "删除 MOD 失败");
  } finally {
    workingPath.value = undefined;
  }
}

async function ensureServerStopped(): Promise<boolean> {
  await refreshRuntime();
  if (activeRuntime.value) {
    serverActiveWarning.value = true;
    return false;
  }
  return true;
}

function handleModError(cause: unknown, title: string): void {
  const message = errorMessage(cause);
  if (message.includes("关停服务器")) serverActiveWarning.value = true;
  else toast.error({ title, description: message });
}

function sortMods(value: readonly ServerInstalledModSnapshot[]): ServerInstalledModSnapshot[] {
  return [...value].sort(
    (left, right) =>
      right.addedAt.localeCompare(left.addedAt) ||
      left.name.localeCompare(right.name, "zh-CN") ||
      left.relativePath.localeCompare(right.relativePath, "zh-CN"),
  );
}

function formatAddedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <section class="server-mod-page" aria-label="Mod">
    <Cmz_Toast position="top-right" />
    <div class="server-mod-list-toolbar">
      <div class="server-mod-search">
        <Search :size="17" :stroke-width="1.8" aria-hidden="true" />
        <input v-model="searchQuery" type="search" placeholder="搜索 Mod" aria-label="搜索 Mod" />
      </div>
      <Cmz_Button
        variant="outline"
        size="sm"
        class="server-mod-add-button"
        :disabled="!selectedInstance"
        @click="addMod"
      >
        <Plus :size="16" :stroke-width="1.8" aria-hidden="true" />
        添加
      </Cmz_Button>
    </div>

    <div v-if="loading" class="server-mod-state" role="status">
      <Cmz_Spinner size="lg" />
      <span>正在读取 Mod</span>
    </div>
    <div v-else-if="error" class="server-mod-state server-mod-state--error" role="alert">
      <Puzzle :size="34" :stroke-width="1.5" aria-hidden="true" />
      <strong>无法读取 Mod</strong>
      <span>{{ error }}</span>
      <Cmz_Button variant="outline" size="sm" @click="retry">重新加载</Cmz_Button>
    </div>
    <div v-else-if="!selectedInstance" class="server-mod-state">
      <Server :size="36" :stroke-width="1.5" aria-hidden="true" />
      <strong>还没有服务器实例</strong>
    </div>
    <template v-else>
      <div class="server-mod-section-heading">
        <h2>Mod</h2>
        <span>{{ visibleMods.length }} 个 Mod</span>
      </div>
      <div v-if="visibleMods.length === 0" class="server-mod-empty">
        <Puzzle :size="30" :stroke-width="1.5" aria-hidden="true" />
        <strong>{{ searchQuery ? "没有匹配的 Mod" : "暂未发现 Mod" }}</strong>
      </div>
      <div v-else class="server-mod-list" aria-label="已安装 Mod 列表" aria-live="polite">
        <article
          v-for="mod in visibleMods"
          :key="mod.relativePath"
          class="server-mod-card"
          :class="{ disabled: mod.disabled, working: workingPath === mod.relativePath }"
        >
          <span class="server-mod-icon">
            <img
              v-if="sourceIconAvailable(mod)"
              :src="mod.resourceSource?.iconUrl"
              alt=""
              draggable="false"
              referrerpolicy="no-referrer"
              @error="markSourceIconFailed(mod.relativePath)"
            />
            <img
              v-else-if="modIconAvailable(mod)"
              :src="mod.iconDataUrl"
              alt=""
              draggable="false"
              @error="markModIconFailed(mod.relativePath)"
            />
            <Puzzle v-else :size="24" :stroke-width="1.7" aria-hidden="true" />
            <Ban
              v-if="mod.disabled"
              class="server-mod-disabled-icon"
              :size="13"
              :stroke-width="2.2"
              aria-hidden="true"
            />
          </span>
          <div class="server-mod-copy">
            <div class="server-mod-title-line">
              <span v-if="mod.disabled" class="server-mod-disabled-tag">已禁用</span>
              <strong>{{ mod.name }}</strong>
              <span v-if="mod.version" class="server-mod-version-tag">{{ mod.version }}</span>
            </div>
            <div class="server-mod-meta">
              <p class="server-mod-description">
                {{ mod.description || "该 MOD 未提供简介。" }}
              </p>
              <span class="server-mod-added">加入时间 {{ formatAddedAt(mod.addedAt) }}</span>
            </div>
          </div>
          <div class="server-mod-actions">
            <Cmz_Button
              v-if="canOpenResourceSource(mod.resourceSource)"
              variant="ghost"
              size="sm"
              :disabled="Boolean(workingPath)"
              @click.stop="openResourceSource(mod)"
            >
              <ExternalLink :size="15" :stroke-width="1.8" aria-hidden="true" />查看来源
            </Cmz_Button>
            <Cmz_Button
              variant="outline"
              size="sm"
              :loading="workingPath === mod.relativePath"
              :disabled="Boolean(workingPath)"
              @click.stop="toggleMod(mod)"
            >
              {{ mod.disabled ? "启用" : "禁用" }}
            </Cmz_Button>
            <Cmz_Button
              variant="ghost"
              size="sm"
              icon-only
              color="var(--sl-error)"
              :disabled="Boolean(workingPath)"
              :aria-label="`删除 ${mod.name}`"
              @click.stop="requestDelete(mod)"
            >
              <Trash2 :size="15" :stroke-width="1.8" aria-hidden="true" />
            </Cmz_Button>
          </div>
        </article>
      </div>
    </template>

    <Cmz_Modal
      :visible="Boolean(deleteTarget)"
      title="删除 Mod"
      width="440px"
      @close="deleteTarget = undefined"
    >
      <div class="server-mod-warning">
        <strong>是否删除此 MOD？此过程不可恢复</strong>
        <p>{{ deleteTarget?.name }}</p>
      </div>
      <template #footer>
        <Cmz_Button variant="ghost" @click="deleteTarget = undefined">取消</Cmz_Button>
        <Cmz_Button color="var(--sl-error)" @click="deleteMod">删除</Cmz_Button>
      </template>
    </Cmz_Modal>

    <Cmz_Modal
      :visible="serverActiveWarning"
      title="无法操作 Mod"
      width="440px"
      @close="serverActiveWarning = false"
    >
      <div class="server-mod-warning">
        <strong>服务器正在运行</strong>
        <p>需要关停服务器之后才能操作 Mod。</p>
      </div>
      <template #footer>
        <Cmz_Button variant="outline" @click="serverActiveWarning = false">知道了</Cmz_Button>
      </template>
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerModManagementPage.css"></style>
