import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** CraftBukkit 各代沿用外层 JAR 启动；1.21.11 精确制品额外拒绝 Java 26+。 */
export const buildBukkitPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "bukkit",
    displayName: "CraftBukkit",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    maximumJavaMajor: context.instance.gameVersion === "1.21.11" ? 25 : undefined,
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    forbiddenWorkingDirectoryCharacters: ["!", "+"],
  });
