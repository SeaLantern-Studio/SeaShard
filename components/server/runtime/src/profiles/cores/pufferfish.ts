import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Paperclip 负责校验和修复内部运行时；Pufferfish 永远从外层 JAR 启动。 */
export const buildPufferfishPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "pufferfish",
    displayName: "Pufferfish",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    forbiddenWorkingDirectoryCharacters: ["!", "+"],
  });
