<script setup lang="ts">
import type { DesktopHostConnection, DesktopHostConnectionsSnapshot } from "@seashard/contracts";
import { Cmz_Button, Cmz_Spinner, useToast } from "cmzya-modern-ui";
import { Cable, Monitor, RotateCw, ShieldCheck, ShieldOff } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import "./HostConnectionsPage.css";
import type { HostConnectionsUiService } from "../service";

const props = defineProps<{
  hosts: HostConnectionsUiService;
}>();
const toast = useToast();
const snapshot = shallowRef<DesktopHostConnectionsSnapshot>();
const loading = ref(true);
const workingHostId = ref<string>();
let stopChanges: (() => void) | undefined;
let latestRevision = -1;

const controllerSessionId = computed(() => snapshot.value?.controllerSessionId);

onMounted(async () => {
  stopChanges = props.hosts.onChanged(acceptSnapshot);
  try {
    acceptSnapshot(await props.hosts.getSnapshot());
  } catch (error) {
    notifyFailure("读取 Host 连接失败", error);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => stopChanges?.());

function acceptSnapshot(value: DesktopHostConnectionsSnapshot): void {
  if (value.revision < latestRevision) return;
  latestRevision = value.revision;
  snapshot.value = value;
}

function statusLabel(host: DesktopHostConnection): string {
  if (host.installation === "missing") return "未安装";
  switch (host.state) {
    case "connecting":
      return "连接中";
    case "control":
      return "当前控制端";
    case "read-only":
      return "只读";
    case "disconnected":
      return "未连接";
    case "error":
      return "连接失败";
  }
}

function statusIcon(host: DesktopHostConnection) {
  if (host.state === "control") return ShieldCheck;
  if (host.state === "read-only") return ShieldOff;
  if (host.state === "connecting") return RotateCw;
  return Cable;
}

function isOwnRequest(host: DesktopHostConnection): boolean {
  return host.pending?.requester.sessionId === controllerSessionId.value;
}

function hasAvailableAction(host: DesktopHostConnection): boolean {
  if (host.installation === "missing") return Boolean(props.hosts.install);
  if (host.state === "error" || host.state === "disconnected") return Boolean(props.hosts.retry);
  if (host.pending) return Boolean(props.hosts.confirmControl && props.hosts.rejectControl);
  if (host.state === "read-only") {
    return Boolean(props.hosts.requestControl || props.hosts.disconnect);
  }
  return host.state === "control"
    ? Boolean(props.hosts.releaseControl || props.hosts.disconnect)
    : false;
}

async function execute(
  host: DesktopHostConnection,
  action: () => Promise<DesktopHostConnectionsSnapshot>,
): Promise<void> {
  if (workingHostId.value) return;
  workingHostId.value = host.id;
  try {
    acceptSnapshot(await action());
  } catch (error) {
    notifyFailure("Host 操作失败", error);
  } finally {
    workingHostId.value = undefined;
  }
}

function notifyFailure(title: string, error: unknown): void {
  toast.error({
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}
</script>

<template>
  <section class="host-connections-page" aria-label="Host 连接">
    <header class="host-connections-header">
      <h1>Host 连接</h1>
    </header>

    <div v-if="loading" class="host-connections-loading">
      <Cmz_Spinner size="lg" />
    </div>

    <div v-else class="host-connections-list">
      <article v-for="host in snapshot?.hosts ?? []" :key="host.id" class="host-connection-card">
        <div class="host-connection-main">
          <span class="host-connection-icon" aria-hidden="true">
            <Monitor v-if="host.transport === 'local'" :size="20" :stroke-width="1.8" />
            <Cable v-else :size="20" :stroke-width="1.8" />
          </span>
          <div class="host-connection-copy">
            <div class="host-connection-name-row">
              <h2>{{ host.label }}</h2>
              <span v-if="host.isDefault" class="host-default-badge">默认</span>
            </div>
            <span class="host-connection-endpoint">{{ host.endpoint }}</span>
          </div>
          <span class="host-state" :data-state="host.state">
            <component
              :is="statusIcon(host)"
              :size="14"
              :stroke-width="1.9"
              :class="{ spinning: host.state === 'connecting' }"
            />
            {{ statusLabel(host) }}
          </span>
        </div>

        <div v-if="host.holder || host.pending || host.error" class="host-connection-details">
          <div v-if="host.holder" class="host-detail-row">
            <span>控制端</span>
            <strong>{{ host.holder.label }}</strong>
          </div>
          <div v-if="host.pending" class="host-detail-row host-detail-row--attention">
            <span>接管请求</span>
            <strong>{{ host.pending.requester.label }}</strong>
          </div>
          <div v-if="host.error" class="host-connection-error">{{ host.error }}</div>
        </div>

        <div v-if="hasAvailableAction(host)" class="host-connection-actions">
          <Cmz_Button
            v-if="host.installation === 'missing' && props.hosts.install"
            size="sm"
            :loading="workingHostId === host.id"
            @click="execute(host, () => props.hosts.install!(host.id))"
          >
            获取 Host
          </Cmz_Button>
          <Cmz_Button
            v-else-if="
              (host.state === 'error' || host.state === 'disconnected') && props.hosts.retry
            "
            size="sm"
            :loading="workingHostId === host.id"
            @click="execute(host, () => props.hosts.retry!(host.id))"
          >
            重新连接
          </Cmz_Button>

          <template
            v-else-if="
              host.pending &&
              isOwnRequest(host) &&
              props.hosts.confirmControl &&
              props.hosts.rejectControl
            "
          >
            <Cmz_Button
              size="sm"
              :loading="workingHostId === host.id"
              @click="
                execute(host, () => props.hosts.confirmControl!(host.id, host.pending!.requestId))
              "
            >
              确认接管
            </Cmz_Button>
            <Cmz_Button
              variant="outline"
              size="sm"
              :disabled="Boolean(workingHostId)"
              @click="
                execute(host, () => props.hosts.rejectControl!(host.id, host.pending!.requestId))
              "
            >
              保持只读
            </Cmz_Button>
          </template>

          <template
            v-else-if="
              host.pending &&
              host.state === 'control' &&
              props.hosts.confirmControl &&
              props.hosts.rejectControl
            "
          >
            <Cmz_Button
              size="sm"
              :loading="workingHostId === host.id"
              @click="
                execute(host, () => props.hosts.confirmControl!(host.id, host.pending!.requestId))
              "
            >
              允许接管
            </Cmz_Button>
            <Cmz_Button
              variant="outline"
              size="sm"
              :disabled="Boolean(workingHostId)"
              @click="
                execute(host, () => props.hosts.rejectControl!(host.id, host.pending!.requestId))
              "
            >
              保持控制
            </Cmz_Button>
          </template>

          <Cmz_Button
            v-else-if="host.state === 'read-only' && props.hosts.requestControl"
            size="sm"
            :loading="workingHostId === host.id"
            @click="execute(host, () => props.hosts.requestControl!(host.id))"
          >
            请求接管
          </Cmz_Button>

          <Cmz_Button
            v-if="host.state === 'control' && props.hosts.releaseControl"
            variant="outline"
            size="sm"
            :loading="workingHostId === host.id"
            @click="execute(host, () => props.hosts.releaseControl!(host.id))"
          >
            释放控制
          </Cmz_Button>

          <Cmz_Button
            v-if="
              (host.state === 'control' || host.state === 'read-only') && props.hosts.disconnect
            "
            variant="outline"
            size="sm"
            :disabled="Boolean(workingHostId)"
            @click="execute(host, () => props.hosts.disconnect!(host.id))"
          >
            断开
          </Cmz_Button>
        </div>
      </article>
    </div>
  </section>
</template>
