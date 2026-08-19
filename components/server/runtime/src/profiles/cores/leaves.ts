import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Leavesclip 仍是永久入口；固定关闭其 cwd 侧路自动更新，避免替换托管制品。 */
export const buildLeavesPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "leaves",
    displayName: "Leaves",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    jvmArguments: ["-Dleavesclip.disable.auto-update=true"],
    programArguments: ["--nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    forbiddenWorkingDirectoryCharacters: ["!", "+"],
  });
