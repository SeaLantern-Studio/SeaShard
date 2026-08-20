import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Pufferfish Purpur 各版本沿用 Paperclip 外层 JAR，并使用对应 Minecraft 的 Java。 */
export const buildPufferfishPurpurPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "pufferfish_purpur",
    displayName: "Pufferfish Purpur",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    exactJavaMajor: true,
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    forbiddenWorkingDirectoryCharacters: ["!"],
  });
