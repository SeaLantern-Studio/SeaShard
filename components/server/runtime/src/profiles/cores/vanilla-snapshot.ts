import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Vanilla 快照与正式版使用相同的外层 server.jar 启动方式。 */
export const buildVanillaSnapshotPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "vanilla-snapshot",
    displayName: "Vanilla Snapshot",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
