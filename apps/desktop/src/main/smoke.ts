import { serverInstanceManagerContract } from "@seashard/server-instance-manager";
import { type RuntimeControlSnapshot, type RuntimeGenerationSnapshot } from "@seashard/plugin-sdk";
import { type PluginKernel, type PluginPackageRecord } from "@seashard/plugin-system";
import { expectServerInstances } from "./contract-validation";

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
    const candidate = await pluginKernel.installer.inspectDevelopmentDirectory(sourceRoot!);
    record = await pluginKernel.installDevelopmentDirectory(sourceRoot!, {
      digest: candidate.digest,
      acknowledgeFullMachineAccess: true,
    });
  }
  await pluginKernel.registry.selectPackageVersion(record);
  const entry = record.manifest.entries.find((candidateEntry) => candidateEntry.runtime === "host");
  if (!entry) throw new Error("smoke plugin must contain a host entry");
  await pluginKernel.upsertBinding({
    id: "smoke.external-plugin",
    pluginId: record.manifest.id,
    entryId: entry.id,
    scopeType: "global",
    scopeId: "global",
    enabled: true,
    config: { marker: "smoke" },
  });
}

export async function verifySmokeRuntime(
  pluginKernel: PluginKernel,
  smokeMode: boolean,
): Promise<void> {
  if (smokeMode) {
    const instances = expectServerInstances(
      await pluginKernel.callService(serverInstanceManagerContract, "list", []),
    );
    console.log(`SEASHARD_SMOKE_SERVER_INSTANCES count=${instances.length}`);
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
    const before = publishedGeneration(pluginKernel.runtimeSnapshot(), "smoke.external-plugin");
    await pluginKernel.reload("smoke.external-plugin");
    const after = publishedGeneration(pluginKernel.runtimeSnapshot(), "smoke.external-plugin");
    const reloadedEcho = await pluginKernel.callService("seashard.smoke.echo", "echo", ["reload"]);
    const activationAfter = await pluginKernel.callService(
      "seashard.smoke.echo",
      "activationCount",
      [],
    );
    if (
      !before ||
      !after ||
      after.generation <= before.generation ||
      after.phase !== "running" ||
      reloadedEcho !== "core-smoke:reload" ||
      typeof activationBefore !== "number" ||
      typeof activationAfter !== "number" ||
      activationAfter !== activationBefore + 1 ||
      pluginKernel.diagnostics().contributions !== 1
    ) {
      throw new Error("external plugin reload did not preserve a single published generation");
    }
    console.log(`SEASHARD_PLUGIN_SMOKE_ECHO ${echo}`);
    console.log(
      `SEASHARD_PLUGIN_SMOKE_RELOADED before=${before.generation} after=${after.generation}`,
    );
    console.log(
      `SEASHARD_PLUGIN_SMOKE_STORAGE before=${activationBefore} after=${activationAfter}`,
    );
  }
}

function publishedGeneration(
  snapshot: RuntimeControlSnapshot,
  runtimeId: string,
): RuntimeGenerationSnapshot | undefined {
  const publication = snapshot.publications.find((candidate) => candidate.runtimeId === runtimeId);
  if (publication?.generation === null || publication?.generation === undefined) return undefined;
  return snapshot.generations.find(
    (generation) =>
      generation.runtimeId === runtimeId && generation.generation === publication.generation,
  );
}
