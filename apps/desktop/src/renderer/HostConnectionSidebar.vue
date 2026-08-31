<script setup lang="ts">
import type { DesktopHostConnection, DesktopHostConnectionsSnapshot } from "@seashard/contracts";
import { Cmz_Button, useToast } from "cmzya-modern-ui";
import { Cable, Monitor, Settings2, ShieldCheck, ShieldOff } from "lucide-vue-next";
import { ref } from "vue";
import "./HostConnectionSidebar.css";

const props = defineProps<{
  snapshot: DesktopHostConnectionsSnapshot;
}>();
const emit = defineEmits<{
  manage: [];
}>();
const toast = useToast();
const workingHostId = ref<string>();

function stateLabel(host: DesktopHostConnection): string {
  switch (host.state) {
    case "connecting":
      return "连接中";
    case "control":
      return "控制";
    case "read-only":
      return "只读";
    case "disconnected":
      return "未连接";
    case "error":
      return "异常";
  }
}

function ownRequest(host: DesktopHostConnection): boolean {
  return host.pending?.requester.sessionId === props.snapshot.controllerSessionId;
}

async function run(host: DesktopHostConnection, action: () => Promise<unknown>): Promise<void> {
  if (workingHostId.value) return;
  workingHostId.value = host.id;
  try {
    await action();
  } catch (error) {
    toast.error({
      title: "Host 操作失败",
      description: error instanceof Error ? error.message : String(error),
    });
  } finally {
    workingHostId.value = undefined;
  }
}

async function retryHost(host: DesktopHostConnection): Promise<void> {
  await run(host, () => window.seashard.hosts.retry(host.id));
}

async function requestHostControl(host: DesktopHostConnection): Promise<void> {
  await run(host, () => window.seashard.hosts.requestControl(host.id));
}

async function confirmHostControl(host: DesktopHostConnection): Promise<void> {
  const requestId = host.pending?.requestId;
  if (!requestId) return;
  await run(host, () => window.seashard.hosts.confirmControl(host.id, requestId));
}
</script>

<template>
  <div class="host-sidebar-content">
    <div class="host-sidebar-heading">
      <h2>Host</h2>
      <button type="button" aria-label="管理 Host" title="管理 Host" @click="emit('manage')">
        <Settings2 :size="16" :stroke-width="1.8" />
      </button>
    </div>

    <div class="host-sidebar-list">
      <section v-for="host in snapshot.hosts" :key="host.id" class="host-sidebar-card">
        <div class="host-sidebar-card-main">
          <span class="host-sidebar-icon" aria-hidden="true">
            <Monitor v-if="host.transport === 'local'" :size="17" :stroke-width="1.8" />
            <Cable v-else :size="17" :stroke-width="1.8" />
          </span>
          <div class="host-sidebar-copy">
            <strong>{{ host.label }}</strong>
            <span>{{ host.endpoint }}</span>
          </div>
          <span class="host-sidebar-state" :data-state="host.state">
            <ShieldCheck v-if="host.state === 'control'" :size="13" :stroke-width="1.9" />
            <ShieldOff v-else-if="host.state === 'read-only'" :size="13" :stroke-width="1.9" />
            {{ stateLabel(host) }}
          </span>
        </div>

        <div v-if="host.holder && host.state === 'read-only'" class="host-sidebar-holder">
          {{ host.holder.label }} 正在控制
        </div>
        <div v-if="host.error" class="host-sidebar-error">{{ host.error }}</div>

        <div class="host-sidebar-actions">
          <Cmz_Button
            v-if="host.state === 'error' || host.state === 'disconnected'"
            size="sm"
            :loading="workingHostId === host.id"
            @click="retryHost(host)"
          >
            重试
          </Cmz_Button>
          <template v-else-if="host.pending && ownRequest(host)">
            <Cmz_Button
              size="sm"
              :loading="workingHostId === host.id"
              @click="confirmHostControl(host)"
            >
              确认接管
            </Cmz_Button>
          </template>
          <template v-else-if="host.pending && host.state === 'control'">
            <Cmz_Button
              size="sm"
              :loading="workingHostId === host.id"
              @click="confirmHostControl(host)"
            >
              允许接管
            </Cmz_Button>
          </template>
          <Cmz_Button
            v-else-if="host.state === 'read-only'"
            size="sm"
            :loading="workingHostId === host.id"
            @click="requestHostControl(host)"
          >
            请求控制
          </Cmz_Button>
        </div>
      </section>
    </div>
  </div>
</template>
