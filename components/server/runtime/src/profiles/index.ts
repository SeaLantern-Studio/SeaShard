import {
  isServerRuntimeSupportedType,
  type ServerInstanceSnapshot,
  type ServerRuntimeSupportedType,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";
import { buildArclightFabricPlan } from "./cores/arclight-fabric";
import { buildArclightForgePlan } from "./cores/arclight-forge";
import { buildArclightNeoForgePlan } from "./cores/arclight-neoforge";
import { buildBannerPlan } from "./cores/banner";
import { buildBukkitPlan } from "./cores/bukkit";
import { buildBungeeCordPlan } from "./cores/bungeecord";
import { buildCatServerPlan } from "./cores/catserver";
import { buildFabricPlan } from "./cores/fabric";
import { buildFoliaPlan } from "./cores/folia";
import { buildLeafPlan } from "./cores/leaf";
import { buildLeavesPlan } from "./cores/leaves";
import { buildLightfallPlan } from "./cores/lightfall";
import { buildMohistPlan } from "./cores/mohist";
import { buildNeoForgePlan } from "./cores/neoforge";
import { buildNukkitxPlan } from "./cores/nukkitx";
import { buildPaperPlan } from "./cores/paper";
import { buildPufferfishPlan } from "./cores/pufferfish";
import { buildPufferfishPurpurPlan } from "./cores/pufferfish-purpur";
import { buildPurpurPlan } from "./cores/purpur";
import { buildQuiltPlan } from "./cores/quilt";
import { buildVanillaPlan } from "./cores/vanilla";
import { buildSpigotPlan } from "./cores/spigot";
import { buildSpongeForgePlan } from "./cores/spongeforge";
import { buildSpongeVanillaPlan } from "./cores/spongevanilla";
import { buildTravertinePlan } from "./cores/travertine";
import { buildVanillaSnapshotPlan } from "./cores/vanilla-snapshot";
import { buildYouerPlan } from "./cores/youer";
import { buildVelocityPlan } from "./cores/velocity";
import { buildManagedJvmArguments } from "./shared/jvm-arguments";
import { validateInstancePaths } from "./shared/paths";
import type { ServerLaunchPlan, ServerProfileBuilder } from "./types";

const profileBuilders = {
  vanilla: buildVanillaPlan,
  paper: buildPaperPlan,
  purpur: buildPurpurPlan,
  folia: buildFoliaPlan,
  fabric: buildFabricPlan,
  quilt: buildQuiltPlan,
  neoforge: buildNeoForgePlan,
  "arclight-neoforge": buildArclightNeoForgePlan,
  mohist: buildMohistPlan,
  velocity: buildVelocityPlan,
  nukkitx: buildNukkitxPlan,
  "arclight-fabric": buildArclightFabricPlan,
  "arclight-forge": buildArclightForgePlan,
  banner: buildBannerPlan,
  bukkit: buildBukkitPlan,
  bungeecord: buildBungeeCordPlan,
  catserver: buildCatServerPlan,
  leaf: buildLeafPlan,
  leaves: buildLeavesPlan,
  lightfall: buildLightfallPlan,
  pufferfish: buildPufferfishPlan,
  pufferfish_purpur: buildPufferfishPurpurPlan,
  spigot: buildSpigotPlan,
  spongeforge: buildSpongeForgePlan,
  spongevanilla: buildSpongeVanillaPlan,
  travertine: buildTravertinePlan,
  "vanilla-snapshot": buildVanillaSnapshotPlan,
  youer: buildYouerPlan,
} satisfies Record<ServerRuntimeSupportedType, ServerProfileBuilder>;

/**
 * 分发层只校验公共输入并选择具体核心；每种核心的版本和安装规则位于 cores 目录。
 * 运行阶段不扫描 JAR，也不从用户重命名后的文件名猜测核心类型。
 */
export function buildServerLaunchPlan(
  instance: ServerInstanceSnapshot,
  settings: ServerSettingsSnapshot,
  platform: NodeJS.Platform = process.platform,
): ServerLaunchPlan {
  validateInstancePaths(instance);
  if (!isServerRuntimeSupportedType(instance.serverType)) {
    throw new Error(`server core type ${instance.serverType ?? "<missing>"} is not supported`);
  }
  return profileBuilders[instance.serverType]({
    instance,
    managedJvmArguments: buildManagedJvmArguments(settings),
    platform,
  });
}

export { parseJvmArguments } from "./shared/jvm-arguments";
export { requiredJavaMajor, selectJavaInstallation } from "./shared/java";
export type {
  ServerPreparationCopyPlan,
  ServerPreparationDownloadPlan,
  JavaVersionRequirement,
  JvmArgumentFilePlan,
  ServerLaunchPlan,
  ServerPreparationPlan,
  ServerProfileBuilder,
  ServerProfileContext,
} from "./types";
