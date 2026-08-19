import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

export const buildPurpurPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "purpur",
    displayName: "Purpur",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
