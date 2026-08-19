import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Arclight Fabric 在同一 JVM 内完成依赖准备，永久入口始终是下载的外层 JAR。 */
export const buildArclightFabricPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "arclight-fabric",
    displayName: "Arclight Fabric",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
