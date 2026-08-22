<script setup lang="ts">
import type { ServerInstanceSnapshot, ServerModVersion } from "@seashard/contracts";
import { Cmz_Button, Cmz_Modal } from "cmzya-modern-ui";
import { Download } from "lucide-vue-next";
import type { Component } from "vue";

type ResourceType = "modpack" | "datapack" | "world";

const props = defineProps<{
  visible: boolean;
  resourceLabel: string;
  resourceType: ResourceType;
  version?: ServerModVersion;
  resourceIcon: Component;
  projectIconUrl?: string;
  iconFailed: boolean;
  canInstallToInstance: boolean;
  instances: readonly ServerInstanceSnapshot[];
  loading: boolean;
  error: string;
  pendingTarget?: string;
  actionError: string;
}>();

const emit = defineEmits<{
  close: [];
  "update:visible": [visible: boolean];
  reload: [];
  "select-instance": [instance: ServerInstanceSnapshot];
  "save-as": [];
}>();
</script>

<template>
  <Cmz_Modal
    :visible="props.visible"
    :title="`${props.resourceLabel}下载`"
    width="520px"
    :close-on-overlay="!props.pendingTarget"
    @close="emit('close')"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="props.version" class="mod-install-modal">
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

      <template v-if="props.canInstallToInstance">
        <h3>下载到</h3>
        <div class="mod-install-instance-list" aria-label="兼容的服务器实例">
          <div v-if="props.loading" class="mod-install-state" role="status">
            <span class="mod-loading-spinner" />
            {{
              props.resourceType === "datapack" ? "正在读取服务器实例与存档" : "正在读取服务器实例"
            }}
          </div>
          <div v-else-if="props.error" class="mod-install-state error" role="alert">
            <span>{{ props.error }}</span>
            <button type="button" @click="emit('reload')">重新加载</button>
          </div>
          <template v-else-if="props.instances.length > 0">
            <button
              v-for="instance in props.instances"
              :key="instance.id"
              class="mod-install-instance"
              type="button"
              :disabled="!!props.pendingTarget"
              @click="emit('select-instance', instance)"
            >
              <span class="mod-install-instance-icon">
                <img v-if="instance.iconUrl" :src="instance.iconUrl" alt="" draggable="false" />
                <span v-else>{{ instance.name.charAt(0).toUpperCase() }}</span>
              </span>
              <span class="mod-install-instance-copy">
                <strong>{{ instance.name }}</strong>
                <span>{{ instance.gameVersion }}</span>
              </span>
              <span
                v-if="props.pendingTarget === instance.id"
                class="mod-loading-spinner"
                aria-label="正在下载"
              />
            </button>
          </template>
          <div v-else class="mod-install-state" role="status">
            {{
              props.resourceType === "datapack"
                ? "没有同时满足版本和已有存档条件的服务器实例"
                : "没有兼容的服务器实例"
            }}
          </div>
        </div>

        <div class="mod-install-separator"><span>或</span></div>
      </template>
      <div v-if="props.actionError" class="mod-install-feedback error" role="alert">
        {{ props.actionError }}
      </div>
      <Cmz_Button
        class="mod-install-save-as"
        variant="outline"
        :loading="props.pendingTarget === 'save-as'"
        :disabled="!!props.pendingTarget"
        @click="emit('save-as')"
      >
        <Download :size="16" :stroke-width="1.8" aria-hidden="true" />
        另存为
      </Cmz_Button>
    </div>
  </Cmz_Modal>
</template>
<style scoped src="./ResourceCommon.css"></style>
<style scoped src="./ResourceFeedback.css"></style>
<style scoped src="./ResourceMotion.css"></style>
<style scoped src="./ResourceInstallModal.css"></style>
