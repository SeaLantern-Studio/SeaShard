import {
  serverInstanceManagerContract,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import type { RuntimeControlSnapshot, RuntimePluginSnapshot } from "@seashard/plugin-sdk";
import { type PluginKernel, type PluginPackageRecord } from "@seashard/plugin-system";

export async function registerSmokePlugin(pluginKernel: PluginKernel): Promise<void> {
  const archivePath = process.env.SEASHARD_SMOKE_PLUGIN_ARCHIVE;
  const sourceRoot = process.env.SEASHARD_SMOKE_PLUGIN_DIR;
  if (!archivePath && !sourceRoot) return;

  let record: PluginPackageRecord;
  if (archivePath) {
    const prepared = await pluginKernel.prepareArchive(archivePath);
    let rejected = false;
    try {
      await prepared.commit({
        digest: "0".repeat(64),
        acknowledgeFullMachineAccess: true,
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("plugin archive accepted a trust grant for the wrong digest");
    console.log("SEASHARD_PLUGIN_SMOKE_TRUST_REJECTED");
    record = await prepared.commit({
      digest: prepared.digest,
      acknowledgeFullMachineAccess: true,
    });
  } else {
    const prepared = await pluginKernel.prepareDirectory(sourceRoot!);
    try {
      record = await prepared.commit({
        digest: prepared.digest,
        acknowledgeFullMachineAccess: true,
      });
    } finally {
      await prepared.dispose();
    }
  }
  await pluginKernel.registry.selectPackageVersion(record);
  const entry = record.manifest.entries.find((candidateEntry) => candidateEntry.runtime === "host");
  if (!entry) throw new Error("smoke plugin must contain a host entry");
  await pluginKernel.upsertBinding({
    id: "smoke.external-plugin",
    pluginId: record.manifest.id,
    entryId: entry.id,
    enabled: true,
    config: { marker: "smoke" },
  });
}

export async function verifySmokeRuntime(
  pluginKernel: PluginKernel,
  smokeMode: boolean,
): Promise<void> {
  if (smokeMode) {
    const instances = await pluginKernel
      .service<ServerInstanceManagerService>(serverInstanceManagerContract)
      .listForClient();
    console.log(`SEASHARD_SMOKE_SERVER_INSTANCES count=${instances.length}`);
    const resource = await pluginKernel.agentResources.snapshot().read("server://instances", {});
    if (
      resource.mimeType !== "application/json" ||
      !resource.content ||
      typeof resource.content !== "object" ||
      Array.isArray(resource.content) ||
      !Array.isArray(resource.content.items)
    ) {
      throw new Error("server instance Agent resource returned an unexpected projection");
    }
    const resourceInstances = resource.content.items;
    if (resourceInstances.length !== instances.length) {
      throw new Error("server instance Agent resource returned an unexpected instance count");
    }
    console.log(`SEASHARD_SMOKE_AGENT_SERVER_RESOURCE count=${resourceInstances.length}`);
  }
  if (process.env.SEASHARD_SMOKE_EXPECT_PLUGIN === "1") {
    const echo = await pluginKernel.callService("seashard.smoke.echo", "echo", ["probe"]);
    if (echo !== "core-smoke:probe") {
      throw new Error(
        `external plugin service returned unexpected value: ${JSON.stringify(echo) ?? "undefined"}`,
      );
    }
    const activationBefore = await pluginKernel.callService(
      "seashard.smoke.echo",
      "activationCount",
      [],
    );
    const resourcesBeforeReload = pluginKernel.agentResources.snapshot();
    const preparedBeforeReload = resourcesBeforeReload.prepare("smoke://state/probe", {
      format: "detail",
    });
    const requestPresentationBeforeReload = await preparedBeforeReload.presentRequest();
    const resourceBeforeReload = await preparedBeforeReload.read();
    const resultPresentationBeforeReload =
      await preparedBeforeReload.presentResult(resourceBeforeReload);
    const defaultPresentationTitle = preparedBeforeReload.definition.presentation?.title;
    const before = activePlugin(pluginKernel.runtimeSnapshot(), "smoke.external-plugin");
    await pluginKernel.reload("smoke.external-plugin");
    const reloadedEcho = await pluginKernel.callService("seashard.smoke.echo", "echo", ["reload"]);
    const after = activePlugin(pluginKernel.runtimeSnapshot(), "smoke.external-plugin");
    let staleResourceRejected = false;
    try {
      await resourcesBeforeReload.read("smoke://state/stale", {});
    } catch (error) {
      staleResourceRejected = error instanceof Error && error.message.includes("Agent 资源已停止");
    }
    const resourceAfterReload = await pluginKernel.agentResources
      .snapshot()
      .read("smoke://state/reload", {});
    const activationAfter = await pluginKernel.callService(
      "seashard.smoke.echo",
      "activationCount",
      [],
    );
    if (
      !before ||
      !after ||
      after.state !== "active" ||
      reloadedEcho !== "core-smoke:reload" ||
      typeof activationBefore !== "number" ||
      typeof activationAfter !== "number" ||
      activationAfter !== activationBefore + 1 ||
      pluginKernel.diagnostics().contributions !== 1 ||
      resourceBeforeReload.content !== "core-smoke:probe:detail" ||
      resourceAfterReload.content !== "core-smoke:reload:plain" ||
      defaultPresentationTitle !== "读取资源" ||
      JSON.stringify(requestPresentationBeforeReload) !==
        JSON.stringify([
          { label: "名称", value: "probe" },
          { label: "格式", value: "detail" },
        ]) ||
      JSON.stringify(resultPresentationBeforeReload) !==
        JSON.stringify([{ value: "1", unit: "个状态" }]) ||
      !staleResourceRejected
    ) {
      throw new Error("external plugin reload did not produce an active plugin");
    }
    console.log(`SEASHARD_PLUGIN_SMOKE_ECHO ${echo}`);
    console.log(`SEASHARD_PLUGIN_SMOKE_RELOADED version=${after.pluginVersion}`);
    console.log(
      `SEASHARD_PLUGIN_SMOKE_STORAGE before=${activationBefore} after=${activationAfter}`,
    );
    console.log(
      `SEASHARD_PLUGIN_SMOKE_RESOURCE before=${resourceBeforeReload.content} after=${resourceAfterReload.content}`,
    );
  }
}

function activePlugin(
  snapshot: RuntimeControlSnapshot,
  runtimeId: string,
): RuntimePluginSnapshot | undefined {
  return snapshot.plugins.find(
    (plugin) => plugin.runtimeId === runtimeId && plugin.state === "active",
  );
}
