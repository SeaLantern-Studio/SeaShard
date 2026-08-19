import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

export const buildVanillaPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "vanilla",
    displayName: "Vanilla",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
