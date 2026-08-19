import { buildDirectJarPlan } from "../shared/direct-jar";
import type { ServerProfileBuilder } from "../types";

export const buildNukkitxPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "nukkitx",
    displayName: "Nukkit-MOT",
    javaMajor: 17,
    programArguments: [],
    eula: "none",
    writesServerProperties: true,
  });
