<script setup lang="ts">
import {
  isServerModSource,
  type ServerResourceSourceMetadata,
  type ServerWorldBackupSnapshot,
  type ServerWorldDatapackSnapshot,
  type ServerWorldSave,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Spinner } from "cmzya-modern-ui";
import {
  Archive,
  ArrowLeft,
  Ban,
  ChevronDown,
  ExternalLink,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-vue-next";
import minecraftDefaultServerIcon from "../assets/minecraft-default-server-icon.png";
import { parseMinecraftFormattingCodes, type MinecraftTextSegment } from "../minecraft-text-format";
import { ref } from "vue";
import { formatWorldSaveDate, formatWorldSaveSize } from "../world-save-format";

const props = defineProps<{
  detailWorldName: string;
  detailWorldId?: string;
  detailSave?: ServerWorldSave;
  backups: readonly ServerWorldBackupSnapshot[];
  dataPacks: readonly ServerWorldDatapackSnapshot[];
  backupsExpanded: boolean;
  dataPacksExpanded: boolean;
  backupLoading: boolean;
  dataPackLoading: boolean;
  backupWorkingFile?: string;
  dataPackWorkingFile?: string;
  restoreTarget?: ServerWorldBackupSnapshot;
  backupLoadFailed: boolean;
  dataPackLoadFailed: boolean;
}>();
const failedDataPackIcons = ref<ReadonlySet<string>>(new Set());

const emit = defineEmits<{
  back: [];
  "toggle-backups": [];
  "toggle-data-packs": [];
  "create-backup": [];
  "retry-backups": [];
  "retry-data-packs": [];
  "restore-backup": [backup: ServerWorldBackupSnapshot];
  "delete-backup": [backup: ServerWorldBackupSnapshot];
  "toggle-data-pack": [dataPack: ServerWorldDatapackSnapshot];
  "delete-data-pack": [dataPack: ServerWorldDatapackSnapshot];
  "open-resource-source": [
    resourceType: "world" | "datapack",
    metadata: ServerResourceSourceMetadata,
  ];
}>();

function goBack(): void {
  emit("back");
}

function toggleBackups(): void {
  emit("toggle-backups");
}

function toggleDataPacks(): void {
  emit("toggle-data-packs");
}

function createBackup(): void {
  emit("create-backup");
}

function retryBackups(): void {
  emit("retry-backups");
}
function retryDataPacks(): void {
  emit("retry-data-packs");
}

function selectRestoreTarget(backup: ServerWorldBackupSnapshot): void {
  emit("restore-backup", backup);
}

function selectDeleteTarget(backup: ServerWorldBackupSnapshot): void {
  emit("delete-backup", backup);
}
function selectDeleteDataPack(dataPack: ServerWorldDatapackSnapshot): void {
  emit("delete-data-pack", dataPack);
}

function toggleDataPack(dataPack: ServerWorldDatapackSnapshot): void {
  emit("toggle-data-pack", dataPack);
}
function openResourceSource(
  resourceType: "world" | "datapack",
  metadata: ServerResourceSourceMetadata,
): void {
  emit("open-resource-source", resourceType, metadata);
}

function canOpenResourceSource(metadata: ServerResourceSourceMetadata): boolean {
  return isServerModSource(metadata.source);
}

function dataPackIconKey(dataPack: ServerWorldDatapackSnapshot): string {
  return `${dataPack.worldId}:${dataPack.fileName}`;
}

function dataPackIconUrl(dataPack: ServerWorldDatapackSnapshot): string | undefined {
  const key = dataPackIconKey(dataPack);
  if (dataPack.iconDataUrl && !failedDataPackIcons.value.has(`${key}:pack`)) {
    return dataPack.iconDataUrl;
  }
  const sourceIconUrl = dataPack.resourceSource?.iconUrl;
  return sourceIconUrl && !failedDataPackIcons.value.has(`${key}:source`)
    ? sourceIconUrl
    : undefined;
}

/** 将数据包简介中的 Minecraft 控制符转换为带样式的安全文本片段。 */
function dataPackDescriptionSegments(value: string | undefined): readonly MinecraftTextSegment[] {
  return value ? parseMinecraftFormattingCodes(value) : [];
}

function markDataPackIconFailed(dataPack: ServerWorldDatapackSnapshot): void {
  const key = dataPackIconKey(dataPack);
  const failureKey =
    dataPack.iconDataUrl && !failedDataPackIcons.value.has(`${key}:pack`)
      ? `${key}:pack`
      : `${key}:source`;
  failedDataPackIcons.value = new Set([...failedDataPackIcons.value, failureKey]);
}
</script>

<template>
  <header class="world-save-heading">
    <div class="world-save-heading-main">
      <Cmz_Button variant="ghost" size="sm" icon-only aria-label="返回存档列表" @click="goBack">
        <ArrowLeft :size="18" :stroke-width="1.8" />
      </Cmz_Button>
      <h1 id="server-world-save-title">{{ detailWorldName }}</h1>
    </div>
  </header>

  <div class="world-save-detail">
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
          >创建 {{ formatWorldSaveDate(detailSave.createdAt) }}　更新
          {{ formatWorldSaveDate(detailSave.updatedAt) }}</small
        >
      </div>
      <div class="world-save-detail-actions">
        <span v-if="detailSave?.current" class="world-save-current">当前存档</span>
        <Cmz_Button
          v-if="detailSave?.resourceSource && canOpenResourceSource(detailSave.resourceSource)"
          variant="ghost"
          size="sm"
          @click="openResourceSource('world', detailSave.resourceSource)"
        >
          <ExternalLink :size="15" :stroke-width="1.8" />查看来源
        </Cmz_Button>
      </div>
    </div>

    <section class="world-save-backups" aria-label="存档资源">
      <div class="world-save-collapsible-group" :class="{ expanded: backupsExpanded }">
        <div class="world-save-collapsible-header">
          <div class="world-save-collapsible-heading">
            <strong id="world-save-backups-title">备份</strong>
            <span>{{ backups.length }} 个备份</span>
          </div>
          <Cmz_Button
            variant="outline"
            size="sm"
            class="world-save-backup-add"
            :loading="backupWorkingFile === 'new'"
            :disabled="Boolean(backupWorkingFile)"
            @click="createBackup"
          >
            <Plus :size="16" :stroke-width="1.8" />新增
          </Cmz_Button>
          <button
            class="world-save-collapsible-trigger"
            type="button"
            :aria-label="backupsExpanded ? '收起备份' : '展开备份'"
            :aria-expanded="backupsExpanded"
            aria-controls="world-save-backup-items"
            @click="toggleBackups"
          >
            <ChevronDown
              class="world-save-collapsible-chevron"
              :class="{ expanded: backupsExpanded }"
              :size="18"
              :stroke-width="1.8"
              aria-hidden="true"
            />
          </button>
        </div>
        <div
          id="world-save-backup-items"
          v-show="backupsExpanded"
          class="world-save-collapsible-items"
        >
          <div v-if="backupLoading" class="world-save-inline-state">
            <Cmz_Spinner size="sm" />正在读取备份
          </div>
          <div v-else-if="backupLoadFailed" class="world-save-inline-state">
            <Archive :size="18" :stroke-width="1.6" />
            <Cmz_Button variant="outline" size="sm" @click="retryBackups">重试</Cmz_Button>
          </div>
          <div v-else-if="backups.length === 0" class="world-save-empty world-save-empty--small">
            <Archive :size="28" :stroke-width="1.5" /><strong>暂无备份</strong>
          </div>
          <div v-else class="world-save-backup-list">
            <article v-for="backup in backups" :key="backup.fileName" class="world-save-backup-row">
              <span class="world-save-icon world-save-icon--small">
                <img
                  v-if="detailSave?.iconDataUrl"
                  :src="detailSave.iconDataUrl"
                  alt=""
                  draggable="false"
                />
                <img v-else :src="minecraftDefaultServerIcon" alt="" draggable="false" />
              </span>
              <span class="world-save-card-copy"
                ><strong>{{ backup.fileName }}</strong
                ><span
                  >{{ formatWorldSaveDate(backup.createdAt) }}　{{
                    formatWorldSaveSize(backup.sizeBytes)
                  }}</span
                ></span
              >
              <div class="world-save-backup-actions">
                <Cmz_Button
                  variant="ghost"
                  size="sm"
                  :loading="backupWorkingFile === backup.fileName && restoreTarget === undefined"
                  :disabled="Boolean(backupWorkingFile)"
                  @click="selectRestoreTarget(backup)"
                >
                  <RotateCcw :size="15" :stroke-width="1.8" />恢复
                </Cmz_Button>
                <Cmz_Button
                  variant="ghost"
                  size="sm"
                  color="var(--sl-error)"
                  :disabled="Boolean(backupWorkingFile)"
                  @click="selectDeleteTarget(backup)"
                >
                  <Trash2 :size="15" :stroke-width="1.8" />删除
                </Cmz_Button>
              </div>
            </article>
          </div>
        </div>
      </div>

      <div class="world-save-collapsible-group" :class="{ expanded: dataPacksExpanded }">
        <div class="world-save-collapsible-header">
          <div class="world-save-collapsible-heading">
            <strong id="world-save-datapacks-title">数据包</strong>
            <span>{{ dataPacks.length }} 个数据包</span>
          </div>
          <button
            class="world-save-collapsible-trigger"
            type="button"
            :aria-label="dataPacksExpanded ? '收起数据包' : '展开数据包'"
            :aria-expanded="dataPacksExpanded"
            aria-controls="world-save-datapack-items"
            @click="toggleDataPacks"
          >
            <ChevronDown
              class="world-save-collapsible-chevron"
              :class="{ expanded: dataPacksExpanded }"
              :size="18"
              :stroke-width="1.8"
              aria-hidden="true"
            />
          </button>
        </div>
        <div
          id="world-save-datapack-items"
          v-show="dataPacksExpanded"
          class="world-save-collapsible-items"
        >
          <div v-if="dataPackLoading" class="world-save-inline-state">
            <Cmz_Spinner size="sm" />正在读取数据包
          </div>
          <div v-else-if="dataPackLoadFailed" class="world-save-inline-state">
            <Archive :size="18" :stroke-width="1.6" />
            <Cmz_Button variant="outline" size="sm" @click="retryDataPacks">重试</Cmz_Button>
          </div>
          <div v-else-if="dataPacks.length === 0" class="world-save-empty world-save-empty--small">
            <Archive :size="28" :stroke-width="1.5" /><strong>暂无数据包</strong>
          </div>
          <div v-else class="world-save-backup-list">
            <article
              v-for="dataPack in dataPacks"
              :key="dataPack.fileName"
              class="world-save-backup-row"
            >
              <span class="world-save-icon world-save-icon--small world-save-datapack-icon">
                <img
                  v-if="dataPackIconUrl(dataPack)"
                  :src="dataPackIconUrl(dataPack)"
                  alt=""
                  draggable="false"
                  @error="markDataPackIconFailed(dataPack)"
                />
                <Archive v-else :size="20" :stroke-width="1.6" aria-hidden="true" />
                <Ban
                  v-if="dataPack.disabled"
                  class="world-save-datapack-disabled-icon"
                  :size="13"
                  :stroke-width="2.2"
                  aria-hidden="true"
                />
              </span>
              <span class="world-save-card-copy">
                <span class="world-save-datapack-name-row">
                  <span v-if="dataPack.disabled" class="world-save-datapack-disabled-tag"
                    >已禁用</span
                  >
                  <strong class="world-save-datapack-name">{{ dataPack.fileName }}</strong>
                  <span
                    v-if="dataPack.resourceSource?.version"
                    class="world-save-datapack-version-tag"
                  >
                    {{ dataPack.resourceSource.version }}
                  </span>
                </span>
                <span class="world-save-datapack-meta">
                  <span
                    class="world-save-datapack-description"
                    :title="dataPack.description || '暂无数据包介绍'"
                  >
                    <template v-if="dataPack.description">
                      <span
                        v-for="(segment, index) in dataPackDescriptionSegments(
                          dataPack.description,
                        )"
                        :key="`${dataPack.fileName}-description-${index}`"
                        class="world-save-minecraft-segment"
                        :class="{
                          'is-bold': segment.bold,
                          'is-italic': segment.italic,
                          'is-underlined': segment.underlined,
                          'is-strikethrough': segment.strikethrough,
                          'is-obfuscated': segment.obfuscated,
                        }"
                        :style="segment.color ? { color: segment.color } : undefined"
                        v-text="segment.text"
                      />
                    </template>
                    <template v-else>暂无数据包介绍</template>
                  </span>
                  <span class="world-save-datapack-updated">
                    更新 {{ formatWorldSaveDate(dataPack.updatedAt) }}
                  </span>
                </span>
              </span>
              <div class="world-save-row-actions">
                <Cmz_Button
                  v-if="dataPack.resourceSource && canOpenResourceSource(dataPack.resourceSource)"
                  variant="ghost"
                  size="sm"
                  @click="openResourceSource('datapack', dataPack.resourceSource)"
                >
                  <ExternalLink :size="15" :stroke-width="1.8" />查看来源
                </Cmz_Button>
                <Cmz_Button
                  variant="outline"
                  size="sm"
                  :loading="dataPackWorkingFile === dataPack.fileName"
                  :disabled="Boolean(dataPackWorkingFile)"
                  @click="toggleDataPack(dataPack)"
                >
                  {{ dataPack.disabled ? "启用" : "禁用" }}
                </Cmz_Button>
                <Cmz_Button
                  variant="ghost"
                  size="sm"
                  icon-only
                  color="var(--sl-error)"
                  aria-label="删除数据包"
                  :disabled="Boolean(dataPackWorkingFile)"
                  @click="selectDeleteDataPack(dataPack)"
                >
                  <Trash2 :size="15" :stroke-width="1.8" />
                </Cmz_Button>
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="./world-save-shared.css"></style>
<style scoped src="./ServerWorldSaveDetail.css"></style>
