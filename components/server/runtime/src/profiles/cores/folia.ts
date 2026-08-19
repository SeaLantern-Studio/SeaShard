import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

export const buildFoliaPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "folia",
    displayName: "Folia",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
