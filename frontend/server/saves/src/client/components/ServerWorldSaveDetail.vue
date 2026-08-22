<script setup lang="ts">
import type { ServerWorldBackupSnapshot, ServerWorldSave } from "@seashard/contracts";
import { Cmz_Button, Cmz_Spinner } from "cmzya-modern-ui";
import { Archive, ArrowLeft, ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-vue-next";
import minecraftDefaultServerIcon from "../assets/minecraft-default-server-icon.png";
import { formatWorldSaveDate, formatWorldSaveSize } from "../world-save-format";

const props = defineProps<{
  detailWorldName: string;
  detailWorldId?: string;
  detailSave?: ServerWorldSave;
  backups: readonly ServerWorldBackupSnapshot[];
  backupsExpanded: boolean;
  dataPacksExpanded: boolean;
  backupLoading: boolean;
  backupWorkingFile?: string;
  restoreTarget?: ServerWorldBackupSnapshot;
  backupLoadFailed: boolean;
}>();

const emit = defineEmits<{
  back: [];
  "toggle-backups": [];
  "toggle-data-packs": [];
  "create-backup": [];
  "retry-backups": [];
  "restore-backup": [backup: ServerWorldBackupSnapshot];
  "delete-backup": [backup: ServerWorldBackupSnapshot];
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

function selectRestoreTarget(backup: ServerWorldBackupSnapshot): void {
  emit("restore-backup", backup);
}

function selectDeleteTarget(backup: ServerWorldBackupSnapshot): void {
  emit("delete-backup", backup);
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
      <span v-if="detailSave?.current" class="world-save-current">当前存档</span>
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
          <div class="world-save-empty world-save-empty--small">
            <Archive :size="28" :stroke-width="1.5" /><strong>暂无数据包</strong>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="./world-save-shared.css"></style>
<style scoped src="./ServerWorldSaveDetail.css"></style>
