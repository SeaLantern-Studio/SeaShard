import { buildDirectJarPlan } from "../shared/direct-jar";
import type { ServerProfileBuilder } from "../types";

export const buildVelocityPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "velocity",
    displayName: "Velocity",
    javaMajor: 21,
    programArguments: [],
    eula: "none",
    writesServerProperties: false,
    stopCommand: "end",
  });
