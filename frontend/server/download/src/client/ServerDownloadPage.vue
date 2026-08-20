<script setup lang="ts">
import {
  formatServerCoreType,
  type ServerCoreArtifact,
  type ServerCoreDownloadClientService,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreSourceClientService,
  type ServerCoreType,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Input, Cmz_Tooltip } from "cmzya-modern-ui";
import { ArrowLeft, ChevronDown, Download, Save } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import CoreIcon from "./CoreIcon.vue";
import type { ResourceCategory } from "./resource-categories";

type CoreView = "catalog" | "versions" | "configuration";

interface CoreCard {
  readonly id: string;
  readonly label: string;
  readonly iconUrl?: string;
}

const props = defineProps<{
  coreSource: ServerCoreSourceClientService;
  downloads: ServerCoreDownloadClientService;
  category: ResourceCategory;
}>();

const router = useRouter();

const catalogTypes = ref<readonly ServerCoreType[]>([]);
const catalogLoading = ref(props.category.id === "server-core");
const catalogError = ref<string>();
const activeView = ref<CoreView>("catalog");
const selectedCore = ref<CoreCard>();
const versions = ref<readonly string[]>([]);
const versionsLoading = ref(false);
const versionsError = ref<string>();
const expandedVersion = ref<string>();
const artifactsByVersion = ref<Record<string, readonly ServerCoreArtifact[]>>({});
const artifactLoadingVersions = ref<Record<string, boolean>>({});
const artifactErrors = ref<Record<string, string | undefined>>({});
const selectedArtifact = ref<ServerCoreArtifact>();
const fileStem = ref("");
const saveAsPending = ref(false);
const managedDownloadPending = ref(false);
const managedDownloadError = ref<string>();
const saveAsError = ref<string>();
let versionsRequestId = 0;
const versionCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const coreCards = computed<readonly CoreCard[]>(() =>
  catalogTypes.value.map((type) => ({
    id: type.id,
    label: formatServerCoreType(type.id),
    ...(type.iconUrl ? { iconUrl: type.iconUrl } : {}),
  })),
);

const configurationTitle = computed(() => {
  if (!selectedCore.value || !selectedArtifact.value) return "";
  return `${selectedCore.value.label} ${selectedArtifact.value.gameVersion}`;
});
const destinationFileName = computed(() => {
  const stem = fileStem.value.trim();
  return stem && !/[\\/]/u.test(stem) ? `${stem}.jar` : undefined;
});

onMounted(() => {
  if (props.category.id === "server-core") void loadCatalogTypes();
});

async function loadCatalogTypes(): Promise<void> {
  catalogLoading.value = true;
  catalogError.value = undefined;
  try {
    catalogTypes.value = await props.coreSource.listTypes();
  } catch (error) {
    catalogError.value = errorMessage(error);
  } finally {
    catalogLoading.value = false;
  }
}

async function selectCore(core: CoreCard): Promise<void> {
  selectedCore.value = core;
  selectedArtifact.value = undefined;
  versions.value = [];
  versionsError.value = undefined;
  expandedVersion.value = undefined;
  artifactsByVersion.value = {};
  artifactErrors.value = {};
  artifactLoadingVersions.value = {};
  activeView.value = "versions";
  await loadVersions(core);
}

async function loadVersions(core = selectedCore.value): Promise<void> {
  if (!core) return;
  const requestId = ++versionsRequestId;
  versionsLoading.value = true;
  versionsError.value = undefined;
  try {
    const result = await props.coreSource.listVersions(core.id);
    const sortedVersions = [...result].sort((left, right) => versionCollator.compare(right, left));
    if (requestId === versionsRequestId && selectedCore.value?.id === core.id) {
      versions.value = sortedVersions;
      for (const version of sortedVersions) void loadArtifacts(version, core, requestId);
    }
  } catch (error) {
    if (requestId === versionsRequestId) versionsError.value = errorMessage(error);
  } finally {
    if (requestId === versionsRequestId) versionsLoading.value = false;
  }
}

async function toggleVersion(version: string): Promise<void> {
  if (expandedVersion.value === version) {
    expandedVersion.value = undefined;
    return;
  }
  expandedVersion.value = version;
  if (Object.hasOwn(artifactsByVersion.value, version)) return;
  await loadArtifacts(version);
}

async function loadArtifacts(
  version: string,
  core = selectedCore.value,
  requestId = versionsRequestId,
): Promise<void> {
  if (!core || artifactLoadingVersions.value[version]) return;
  artifactLoadingVersions.value = { ...artifactLoadingVersions.value, [version]: true };
  artifactErrors.value = { ...artifactErrors.value, [version]: undefined };
  try {
    const artifacts = await props.coreSource.listArtifacts(core.id, version);
    if (requestId === versionsRequestId && selectedCore.value?.id === core.id) {
      artifactsByVersion.value = { ...artifactsByVersion.value, [version]: artifacts };
    }
  } catch (error) {
    if (requestId === versionsRequestId) {
      artifactErrors.value = { ...artifactErrors.value, [version]: errorMessage(error) };
    }
  } finally {
    if (requestId === versionsRequestId) {
      artifactLoadingVersions.value = {
        ...artifactLoadingVersions.value,
        [version]: false,
      };
    }
  }
}

function configureArtifact(artifact: ServerCoreArtifact): void {
  selectedArtifact.value = artifact;
  fileStem.value = stripJarExtension(artifact.fileName);
  saveAsError.value = undefined;
  managedDownloadError.value = undefined;
  activeView.value = "configuration";
}

function returnToCatalog(): void {
  versionsRequestId += 1;
  activeView.value = "catalog";
  selectedCore.value = undefined;
  selectedArtifact.value = undefined;
  versionsLoading.value = false;
}

function returnToVersions(): void {
  activeView.value = "versions";
  selectedArtifact.value = undefined;
  saveAsError.value = undefined;
  managedDownloadError.value = undefined;
}

function updateFileStem(value: string): void {
  fileStem.value = stripJarExtension(value);
  saveAsError.value = undefined;
  managedDownloadError.value = undefined;
}

function stripJarExtension(fileName: string): string {
  return fileName.replace(/\.jar$/iu, "");
}

function artifactCount(version: string): number | undefined {
  return Object.hasOwn(artifactsByVersion.value, version)
    ? artifactsByVersion.value[version]?.length
    : undefined;
}

async function downloadManagedInstance(): Promise<void> {
  const artifact = selectedArtifact.value;
  const destination = destinationFileName.value;
  if (!artifact || !destination || managedDownloadPending.value || saveAsPending.value) return;

  managedDownloadPending.value = true;
  saveAsError.value = undefined;
  managedDownloadError.value = undefined;
  try {
    const result = await props.downloads.startManaged({
      serverType: artifact.serverType,
      gameVersion: artifact.gameVersion,
      artifactFileName: artifact.fileName,
      destinationFileName: destination,
    });
    const completed = await waitForDownload(result.task.id);
    if (completed.state !== "completed") {
      throw new Error(
        completed.error ??
          (completed.state === "cancelled" ? "服务器核心下载已取消" : "服务器核心下载失败"),
      );
    }
    await router.push({
      path: "/server/launch",
      query: { instance: result.instanceId },
    });
  } catch (error) {
    managedDownloadError.value = errorMessage(error);
  } finally {
    managedDownloadPending.value = false;
  }
}

/** 等待顶栏共享任务进入终态，成功后才能跳转到已经写入注册表的实例。 */
async function waitForDownload(taskId: string): Promise<ServerCoreDownloadTaskSnapshot> {
  for (;;) {
    const task = (await props.downloads.listTasks()).find(({ id }) => id === taskId);
    if (!task) throw new Error("服务器核心下载任务已丢失");
    if (["completed", "failed", "cancelled"].includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function saveArtifactAs(): Promise<void> {
  const artifact = selectedArtifact.value;
  const destination = destinationFileName.value;
  if (!artifact || !destination || saveAsPending.value || managedDownloadPending.value) return;

  saveAsPending.value = true;
  saveAsError.value = undefined;
  managedDownloadError.value = undefined;
  try {
    await props.downloads.saveAs({
      serverType: artifact.serverType,
      gameVersion: artifact.gameVersion,
      artifactFileName: artifact.fileName,
      destinationFileName: destination,
    });
  } catch (error) {
    saveAsError.value = errorMessage(error);
  } finally {
    saveAsPending.value = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section
    class="server-download-page"
    :class="{ 'configuration-view': activeView === 'configuration' }"
    :aria-labelledby="`resource-title-${category.id}`"
  >
    <template v-if="category.id !== 'server-core'">
      <h1 :id="`resource-title-${category.id}`" class="plain-title">{{ category.label }}</h1>
    </template>

    <Transition v-else name="view-shift" mode="out-in">
      <div v-if="activeView === 'catalog'" key="catalog" class="view-panel">
        <h1 :id="`resource-title-${category.id}`" class="plain-title">{{ category.label }}</h1>

        <div v-if="catalogLoading" class="core-card-grid" aria-label="正在加载服务器核心">
          <div v-for="index in 12" :key="index" class="core-card core-card-loading">
            <div class="core-icon-placeholder"></div>
            <div class="core-card-label-placeholder"></div>
          </div>
        </div>

        <div v-else-if="catalogError" class="catalog-error" role="alert">
          <p>无法读取服务器核心目录</p>
          <span>{{ catalogError }}</span>
          <Cmz_Button variant="outline" size="sm" @click="loadCatalogTypes"> 重新加载 </Cmz_Button>
        </div>

        <div v-else class="core-card-grid" aria-label="服务器核心列表">
          <button
            v-for="core in coreCards"
            :key="core.id"
            type="button"
            class="core-card"
            :data-core-id="core.id"
            @click="selectCore(core)"
          >
            <CoreIcon :core-id="core.id" :label="core.label" :icon-url="core.iconUrl" />
            <span class="core-card-label">{{ core.label }}</span>
          </button>
        </div>
      </div>

      <div v-else-if="activeView === 'versions' && selectedCore" key="versions" class="view-panel">
        <div class="view-heading">
          <button
            type="button"
            class="icon-back-button"
            aria-label="返回服务器核心"
            @click="returnToCatalog"
          >
            <ArrowLeft :size="19" :stroke-width="1.9" />
          </button>
          <CoreIcon
            :core-id="selectedCore.id"
            :label="selectedCore.label"
            :icon-url="selectedCore.iconUrl"
            size="row"
          />
          <h1 :id="`resource-title-${category.id}`">{{ selectedCore.label }}</h1>
        </div>

        <div v-if="versionsLoading" class="version-list" aria-label="正在加载游戏版本">
          <div v-for="index in 7" :key="index" class="version-row version-row-loading">
            <div class="version-label-placeholder"></div>
          </div>
        </div>

        <div v-else-if="versionsError" class="catalog-error" role="alert">
          <p>无法读取支持的 Minecraft 版本</p>
          <span>{{ versionsError }}</span>
          <Cmz_Button variant="outline" size="sm" @click="loadVersions()"> 重新加载 </Cmz_Button>
        </div>

        <div v-else-if="versions.length === 0" class="empty-state">
          <p>当前核心暂未提供可下载版本</p>
          <span>返回上一级选择其他服务端核心。</span>
        </div>

        <div v-else class="version-list" aria-label="Minecraft 版本列表">
          <article
            v-for="version in versions"
            :key="version"
            class="version-row"
            :class="{ expanded: expandedVersion === version }"
          >
            <button
              type="button"
              class="version-row-trigger"
              :aria-expanded="expandedVersion === version"
              @click="toggleVersion(version)"
            >
              <span class="version-summary">
                <span class="version-number">{{ version }}</span>
                <span class="version-count">({{ artifactCount(version) ?? "…" }})</span>
              </span>
              <ChevronDown class="version-chevron" :size="18" :stroke-width="1.8" />
            </button>

            <div class="artifact-panel" :aria-hidden="expandedVersion !== version">
              <div class="artifact-panel-inner">
                <div v-if="artifactLoadingVersions[version]" class="artifact-loading">
                  <span v-for="index in 3" :key="index"></span>
                </div>
                <div v-else-if="artifactErrors[version]" class="artifact-error" role="alert">
                  <span>{{ artifactErrors[version] }}</span>
                  <Cmz_Button variant="ghost" size="sm" @click="loadArtifacts(version)">
                    重试
                  </Cmz_Button>
                </div>
                <div v-else-if="artifactsByVersion[version]?.length === 0" class="artifact-empty">
                  该 Minecraft 版本暂无可下载构建
                </div>
                <template v-else>
                  <button
                    v-for="artifact in artifactsByVersion[version] ?? []"
                    :key="artifact.fileName"
                    type="button"
                    class="artifact-row"
                    @click="configureArtifact(artifact)"
                  >
                    <CoreIcon
                      :core-id="selectedCore.id"
                      :label="selectedCore.label"
                      :icon-url="selectedCore.iconUrl"
                      size="row"
                    />
                    <strong class="artifact-name">{{
                      stripJarExtension(artifact.fileName)
                    }}</strong>
                  </button>
                </template>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div
        v-else-if="activeView === 'configuration' && selectedCore && selectedArtifact"
        key="configuration"
        class="view-panel configuration-panel"
      >
        <div class="configuration-heading">
          <button
            type="button"
            class="icon-back-button"
            aria-label="返回版本选择"
            @click="returnToVersions"
          >
            <ArrowLeft :size="20" :stroke-width="1.9" />
          </button>
          <h1 :id="`resource-title-${category.id}`">{{ configurationTitle }}</h1>
        </div>

        <div class="configuration-body">
          <CoreIcon
            :core-id="selectedCore.id"
            :label="selectedCore.label"
            :icon-url="selectedCore.iconUrl"
            size="detail"
          />
          <div class="filename-field">
            <label class="sr-only" for="server-core-file-name">文件名</label>
            <Cmz_Input
              id="server-core-file-name"
              class="filename-input"
              :model-value="fileStem"
              :maxlength="180"
              @update:model-value="updateFileStem"
            />
          </div>
        </div>

        <div class="download-action-bar" aria-label="下载操作">
          <Cmz_Button
            class="download-primary"
            size="lg"
            :loading="managedDownloadPending"
            :disabled="!destinationFileName || managedDownloadPending || saveAsPending"
            @click="downloadManagedInstance"
          >
            <Download :size="19" :stroke-width="2" />
            开始下载
          </Cmz_Button>
          <Cmz_Tooltip class="save-action-wrap" content="另存为" placement="top">
            <Cmz_Button
              class="save-action"
              variant="outline"
              size="lg"
              icon-only
              aria-label="另存为"
              :loading="saveAsPending"
              :disabled="!destinationFileName || saveAsPending || managedDownloadPending"
              @click="saveArtifactAs"
            >
              <Save :size="19" :stroke-width="1.9" />
            </Cmz_Button>
          </Cmz_Tooltip>
        </div>
        <p v-if="managedDownloadError || saveAsError" class="download-start-error" role="alert">
          {{ managedDownloadError ?? saveAsError }}
        </p>
      </div>
    </Transition>
  </section>
</template>

<style scoped src="./ServerDownloadPage.css"></style>
