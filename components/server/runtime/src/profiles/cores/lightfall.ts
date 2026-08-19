import { buildDirectJarPlan } from "../shared/direct-jar";
import type { ServerProfileBuilder } from "../types";

/** Lightfall 没有安装阶段；其 Waterfall 模块失败不改变基础代理的永久入口。 */
export const buildLightfallPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "lightfall",
    displayName: "Lightfall",
    javaMajor: 8,
    programArguments: [],
    eula: "none",
    writesServerProperties: false,
    stopCommand: "end",
    forbiddenWorkingDirectoryCharacters: ["!"],
  });
