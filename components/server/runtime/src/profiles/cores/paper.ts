import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

export const buildPaperPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "paper",
    displayName: "Paper",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
