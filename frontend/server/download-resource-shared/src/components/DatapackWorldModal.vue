<script setup lang="ts">
import type { ServerInstanceSnapshot, ServerModVersion } from "@seashard/contracts";
import { Cmz_Modal } from "cmzya-modern-ui";
import type { Component } from "vue";
import { datapackPendingTarget, type DatapackWorldTarget } from "../resource-presentation";

const props = defineProps<{
  visible: boolean;
  version?: ServerModVersion;
  targetInstance?: ServerInstanceSnapshot;
  worldTargets: readonly DatapackWorldTarget[];
  resourceIcon: Component;
  projectIconUrl?: string;
  iconFailed: boolean;
  defaultWorldIcon: string;
  pendingTarget?: string;
  actionError: string;
}>();

const emit = defineEmits<{
  close: [];
  "update:visible": [visible: boolean];
  back: [];
  "select-world": [world: DatapackWorldTarget];
}>();

function isWorldPending(worldId: string): boolean {
  return (
    !!props.targetInstance &&
    props.pendingTarget === datapackPendingTarget(props.targetInstance.id, worldId)
  );
}
</script>

<template>
  <Cmz_Modal
    :visible="props.visible"
    title="数据包下载到存档"
    width="520px"
    :close-on-overlay="!props.pendingTarget"
    @close="emit('close')"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="props.version && props.targetInstance" class="mod-install-modal">
      <div class="mod-install-file">
        <span class="mod-project-icon mod-version-icon">
          <img
            v-if="props.projectIconUrl && !props.iconFailed"
            :src="props.projectIconUrl"
            alt=""
            draggable="false"
            referrerpolicy="no-referrer"
          />
          <component
            :is="props.resourceIcon"
            v-else
            :size="16"
            :stroke-width="1.7"
            aria-hidden="true"
          />
        </span>
        <div>
          <span>准备下载</span>
          <strong>{{ props.version.fileName }}</strong>
        </div>
      </div>

      <div class="mod-install-target-context">
        <span class="mod-install-instance-icon">
          <img
            v-if="props.targetInstance.iconUrl"
            :src="props.targetInstance.iconUrl"
            alt=""
            draggable="false"
          />
          <span v-else>{{ props.targetInstance.name.charAt(0).toUpperCase() }}</span>
        </span>
        <div class="mod-install-instance-copy">
          <strong>{{ props.targetInstance.name }}</strong>
          <span>{{ props.targetInstance.gameVersion }}</span>
        </div>
      </div>

      <h3>选择存档</h3>
      <div class="mod-install-instance-list" aria-label="可用存档">
        <button
          v-for="world in props.worldTargets"
          :key="world.id"
          class="mod-install-instance"
          type="button"
          :disabled="!!props.pendingTarget"
          @click="emit('select-world', world)"
        >
          <span class="mod-install-instance-icon">
            <img v-if="world.iconDataUrl" :src="world.iconDataUrl" alt="" draggable="false" />
            <img v-else :src="props.defaultWorldIcon" alt="" draggable="false" />
          </span>
          <span class="mod-install-instance-copy">
            <strong>{{ world.name }}</strong>
            <span>{{ world.current ? "当前存档" : "存档" }}</span>
          </span>
          <span v-if="isWorldPending(world.id)" class="mod-loading-spinner" aria-label="正在下载" />
        </button>
        <div v-if="props.worldTargets.length === 0" class="mod-install-state" role="status">
          当前实例没有可用存档
        </div>
      </div>

      <div v-if="props.actionError" class="mod-install-feedback error" role="alert">
        {{ props.actionError }}
      </div>
      <button
        class="mod-install-back"
        type="button"
        :disabled="!!props.pendingTarget"
        @click="emit('back')"
      >
        返回服务器实例
      </button>
    </div>
  </Cmz_Modal>
</template>
<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceFeedback.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceInstallModal.css"></style>
