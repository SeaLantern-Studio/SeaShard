import {
  isServerRuntimeSupportedType,
  type ServerInstanceSnapshot,
  type ServerRuntimeSupportedType,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";
import { buildArclightNeoForgePlan } from "./cores/arclight-neoforge";
import { buildFabricPlan } from "./cores/fabric";
import { buildFoliaPlan } from "./cores/folia";
import { buildMohistPlan } from "./cores/mohist";
import { buildNeoForgePlan } from "./cores/neoforge";
import { buildNukkitxPlan } from "./cores/nukkitx";
import { buildPaperPlan } from "./cores/paper";
import { buildPurpurPlan } from "./cores/purpur";
import { buildQuiltPlan } from "./cores/quilt";
import { buildVanillaPlan } from "./cores/vanilla";
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
  FileHashManifestPlan,
  JavaVersionRequirement,
  JvmArgumentFilePlan,
  ServerLaunchPlan,
  ServerPreparationPlan,
  ServerProfileBuilder,
  ServerProfileContext,
} from "./types";
