import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** SpongeVanilla 各版本运行原始安装器 JAR，并固定到对应 Minecraft 要求的 Java。 */
export const buildSpongeVanillaPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "spongevanilla",
    displayName: "SpongeVanilla",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    exactJavaMajor: true,
    programArguments: [],
    eula: "minecraft",
    writesServerProperties: true,
  });
