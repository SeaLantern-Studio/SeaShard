import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** QuantumLeaper 负责下载和修补；内部 Leaf JAR 缺少外层组装的 classpath。 */
export const buildLeafPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "leaf",
    displayName: "Leaf",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    forbiddenWorkingDirectoryCharacters: ["!"],
  });
