<script setup lang="ts">
import type {
  ServerInstanceClientService,
  ServerInstanceSnapshot,
  ServerPlayerCatalog,
  ServerPlayerManagerService,
  ServerPlayerSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Spinner, Cmz_Switch, useToast } from "cmzya-modern-ui";
import { Ban, Check, RefreshCw, ShieldCheck, UserPlus, Users } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{
  instances: ServerInstanceClientService;
  players: ServerPlayerManagerService;
  selection: ServerInstanceSelection;
}>();
const toast = useToast();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const catalog = ref<ServerPlayerCatalog>();
const loading = ref(false);
const pendingPlayerUuid = ref<string>();
const playerName = ref("");
const playerUuid = ref("");
const banTarget = ref<ServerPlayerSnapshot>();
const banReason = ref("");
const selectedInstanceId = computed(() => props.selection.instanceId);

onMounted(() => void loadInstances());
watch(selectedInstanceId, () => void loadPlayers());

async function loadInstances(): Promise<void> {
  loading.value = true;
  try {
    registeredInstances.value = await props.instances.list();
    if (!registeredInstances.value.some(({ id }) => id === props.selection.instanceId)) {
      props.selection.instanceId = registeredInstances.value[0]?.id;
    }
    await loadPlayers();
  } catch (error) {
    toast.error({ title: "读取玩家失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function loadPlayers(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    catalog.value = undefined;
    return;
  }
  loading.value = true;
  try {
    catalog.value = await props.players.list(instanceId);
  } catch (error) {
    toast.error({ title: "读取玩家名单失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function setWhitelistEnabled(enabled: boolean): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) return;
  try {
    catalog.value = await props.players.setWhitelistEnabled(instanceId, enabled);
    toast.success({ title: enabled ? "白名单已启用" : "白名单已关闭" });
  } catch (error) {
    toast.error({ title: "修改白名单失败", description: errorMessage(error) });
  }
}

async function addWhitelistedPlayer(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || !playerName.value.trim() || !playerUuid.value.trim()) return;
  try {
    catalog.value = await props.players.setWhitelisted(
      instanceId,
      { name: playerName.value.trim(), uuid: playerUuid.value.trim() },
      true,
    );
    playerName.value = "";
    playerUuid.value = "";
    toast.success({ title: "玩家已加入白名单" });
  } catch (error) {
    toast.error({ title: "添加玩家失败", description: errorMessage(error) });
  }
}

async function toggleWhitelisted(player: ServerPlayerSnapshot): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || pendingPlayerUuid.value) return;
  pendingPlayerUuid.value = player.uuid;
  try {
    catalog.value = await props.players.setWhitelisted(instanceId, player, !player.whitelisted);
    toast.success({ title: player.whitelisted ? "玩家已移出白名单" : "玩家已加入白名单" });
  } catch (error) {
    toast.error({ title: "修改白名单失败", description: errorMessage(error) });
  } finally {
    pendingPlayerUuid.value = undefined;
  }
}

async function pardon(player: ServerPlayerSnapshot): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || pendingPlayerUuid.value) return;
  pendingPlayerUuid.value = player.uuid;
  try {
    catalog.value = await props.players.setBanned(instanceId, player, false);
    toast.success({ title: "玩家封禁已解除" });
  } catch (error) {
    toast.error({ title: "解除封禁失败", description: errorMessage(error) });
  } finally {
    pendingPlayerUuid.value = undefined;
  }
}

async function confirmBan(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const player = banTarget.value;
  if (!instanceId || !player || pendingPlayerUuid.value) return;
  pendingPlayerUuid.value = player.uuid;
  try {
    catalog.value = await props.players.setBanned(
      instanceId,
      { name: player.name, uuid: player.uuid, reason: banReason.value.trim() || undefined },
      true,
    );
    banTarget.value = undefined;
    banReason.value = "";
    toast.success({ title: "玩家已封禁" });
  } catch (error) {
    toast.error({ title: "封禁玩家失败", description: errorMessage(error) });
  } finally {
    pendingPlayerUuid.value = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-players-page">
    <header class="page-heading"><h1>玩家</h1></header>
    <div class="players-toolbar">
      <select v-model="selection.instanceId" aria-label="服务器实例">
        <option v-for="instance in registeredInstances" :key="instance.id" :value="instance.id">
          {{ instance.name }}
        </option>
      </select>
      <div v-if="catalog" class="whitelist-control">
        <ShieldCheck :size="17" />
        <span>白名单</span>
        <Cmz_Switch
          :model-value="catalog.whitelistEnabled"
          @update:model-value="setWhitelistEnabled"
        />
      </div>
      <Cmz_Button variant="outline" size="sm" :disabled="loading" @click="loadPlayers">
        <RefreshCw :size="15" /> 刷新
      </Cmz_Button>
    </div>

    <div class="add-player-row">
      <input v-model="playerName" maxlength="16" placeholder="玩家名称" />
      <input
        v-model="playerUuid"
        maxlength="36"
        placeholder="UUID"
        @keydown.enter="addWhitelistedPlayer"
      />
      <Cmz_Button
        :disabled="!playerName.trim() || !playerUuid.trim()"
        @click="addWhitelistedPlayer"
      >
        <UserPlus :size="16" /> 加入白名单
      </Cmz_Button>
    </div>

    <Cmz_Spinner v-if="loading" />
    <div v-else-if="catalog?.players.length" class="player-list">
      <article v-for="player in catalog.players" :key="player.uuid" class="player-row">
        <span class="player-avatar"><Users :size="18" /></span>
        <div class="player-identity">
          <strong>{{ player.name }}</strong>
          <code>{{ player.uuid }}</code>
        </div>
        <div class="player-flags">
          <span v-if="player.operator" class="flag">管理员</span>
          <span v-if="player.whitelisted" class="flag allowed"><Check :size="13" /> 白名单</span>
          <span v-if="player.banned" class="flag banned"><Ban :size="13" /> 已封禁</span>
        </div>
        <div class="player-actions">
          <Cmz_Button
            variant="outline"
            size="sm"
            :loading="pendingPlayerUuid === player.uuid"
            @click="toggleWhitelisted(player)"
          >
            {{ player.whitelisted ? "移出白名单" : "加入白名单" }}
          </Cmz_Button>
          <Cmz_Button v-if="player.banned" variant="outline" size="sm" @click="pardon(player)"
            >解除封禁</Cmz_Button
          >
          <Cmz_Button v-else variant="outline" size="sm" @click="banTarget = player"
            >封禁</Cmz_Button
          >
        </div>
      </article>
    </div>
    <div v-else class="empty-state"><Users :size="30" /><span>暂无已知玩家</span></div>

    <Cmz_Modal
      :visible="Boolean(banTarget)"
      title="封禁玩家"
      width="440px"
      @close="banTarget = undefined"
    >
      <label class="ban-field">
        <span>封禁原因</span>
        <input v-model="banReason" maxlength="256" placeholder="Banned by SeaShard" />
      </label>
      <template #footer>
        <div class="modal-actions">
          <Cmz_Button variant="outline" @click="banTarget = undefined">取消</Cmz_Button>
          <Cmz_Button color="#ef4444" @click="confirmBan">确认封禁</Cmz_Button>
        </div>
      </template>
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerPlayersPage.css"></style>
