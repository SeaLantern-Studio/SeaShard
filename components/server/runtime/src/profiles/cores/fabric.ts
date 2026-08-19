import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

export const buildFabricPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "fabric",
    displayName: "Fabric",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
