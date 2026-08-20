<script setup lang="ts">
import { Cmz_Button, Cmz_Modal } from "cmzya-modern-ui";
import { AlertTriangle } from "lucide-vue-next";
import { computed } from "vue";

const props = defineProps<{
  visible: boolean;
  message: string;
}>();

const title = computed(() => {
  const majorVersion = /未检测到已启用的 Java (\d+)/u.exec(props.message)?.[1];
  return majorVersion ? `缺少 Java ${majorVersion}` : "缺少所需 Java";
});

const emit = defineEmits<{
  "update:visible": [visible: boolean];
}>();

function setVisible(visible: boolean): void {
  emit("update:visible", visible);
}
</script>

<template>
  <Cmz_Modal
    :visible="props.visible"
    :title="title"
    width="440px"
    :close-on-overlay="false"
    @close="setVisible(false)"
    @update:visible="setVisible"
  >
    <div class="java-requirement-content">
      <span class="java-requirement-icon" aria-hidden="true">
        <AlertTriangle :size="21" />
      </span>
      <p>{{ props.message }}</p>
    </div>
    <template #footer>
      <div class="java-requirement-actions">
        <Cmz_Button @click="setVisible(false)">确认</Cmz_Button>
      </div>
    </template>
  </Cmz_Modal>
</template>

<style scoped>
.java-requirement-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.java-requirement-content p {
  margin: 0;
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
  line-height: var(--sl-line-height-normal);
  overflow-wrap: anywhere;
}

.java-requirement-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--sl-radius-md);
  background: var(--sl-warning-bg);
  color: var(--sl-warning);
}

.java-requirement-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
