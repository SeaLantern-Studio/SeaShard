import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

export const buildArclightNeoForgePlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "arclight-neoforge",
    displayName: "Arclight NeoForge",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "minecraft",
    writesServerProperties: true,
  });
