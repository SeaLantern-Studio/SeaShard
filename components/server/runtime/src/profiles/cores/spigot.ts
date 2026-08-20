import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Spigot 各版本沿用外层 Bootstrap JAR，Java 版本由 Minecraft 版本决定。 */
export const buildSpigotPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "spigot",
    displayName: "Spigot",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    forbiddenWorkingDirectoryCharacters: ["!", "+"],
  });
