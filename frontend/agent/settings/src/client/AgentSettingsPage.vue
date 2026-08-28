<script setup lang="ts">
import type { AgentSettingsService, AgentSettingsSnapshot } from "@seashard/contracts";
import { Cmz_Spinner, Cmz_Switch, Cmz_Toast, useToast } from "cmzya-modern-ui";
import { onMounted, ref, shallowRef } from "vue";
import "./AgentSettingsPage.css";

const props = defineProps<{
  settings: AgentSettingsService;
}>();

const toast = useToast();
const snapshot = shallowRef<AgentSettingsSnapshot>();
const loading = ref(true);
const saving = ref(false);

onMounted(() => void loadSettings());

async function loadSettings(): Promise<void> {
  try {
    snapshot.value = await props.settings.get();
  } catch (error) {
    toast.error({ title: "读取 Agent 设置失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function updateAutomaticConversationSummary(enabled: boolean): Promise<void> {
  if (saving.value || !snapshot.value) return;
  saving.value = true;
  try {
    snapshot.value = await props.settings.setAutomaticConversationSummary(enabled);
    toast.success({ title: "Agent 设置已保存" });
  } catch (error) {
    toast.error({ title: "保存 Agent 设置失败", description: errorMessage(error) });
  } finally {
    saving.value = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="agent-general-settings-page" aria-label="Agent 常规设置">
    <Cmz_Toast position="top-right" />
    <header class="agent-general-settings-header">
      <h1>常规</h1>
    </header>

    <div v-if="loading" class="agent-general-settings-loading">
      <Cmz_Spinner size="lg" />
    </div>

    <div v-else-if="snapshot" class="agent-general-settings-list">
      <div class="agent-general-settings-row">
        <div class="agent-general-settings-copy">
          <h2>自动总结对话</h2>
          <p>根据首轮问题和后续回答定期更新对话标题。</p>
        </div>
        <Cmz_Switch
          :model-value="snapshot.automaticConversationSummary"
          :disabled="saving"
          aria-label="自动总结对话"
          @update:model-value="updateAutomaticConversationSummary"
        />
      </div>
    </div>
  </section>
</template>
