import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Forge installer 由 Arclight 外层进程按需调度；生成的 Forge 脚本不是永久入口。 */
export const buildArclightForgePlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "arclight-forge",
    displayName: "Arclight Forge",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
