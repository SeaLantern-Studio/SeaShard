import { buildDirectJarPlan } from "../shared/direct-jar";
import type { ServerProfileBuilder } from "../types";

/** Travertine 是自引导 BungeeCord 代理，控制台安全停止命令为 end。 */
export const buildTravertinePlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "travertine",
    displayName: "Travertine",
    javaMajor: 8,
    programArguments: [],
    eula: "none",
    writesServerProperties: false,
    stopCommand: "end",
    forbiddenWorkingDirectoryCharacters: ["!"],
  });
