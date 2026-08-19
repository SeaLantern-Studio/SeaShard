import { buildDirectJarPlan } from "../shared/direct-jar";
import type { ServerProfileBuilder } from "../types";

/** BungeeCord 自行准备模块，但始终运行原 JAR；代理使用 end 而不是 stop。 */
export const buildBungeeCordPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "bungeecord",
    displayName: "BungeeCord",
    javaMajor: 8,
    programArguments: [],
    eula: "none",
    writesServerProperties: false,
    stopCommand: "end",
  });
