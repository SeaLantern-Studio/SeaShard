import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

const catServerModuleArguments = [
  "--add-exports=java.base/sun.security.util=ALL-UNNAMED",
  "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
  "--add-opens=java.base/java.lang=ALL-UNNAMED",
] as const;

/** CatServer 各代都从外层 JAR 启动；Java 9+ 才支持 1.18.2 所需的模块开放参数。 */
export const buildCatServerPlan: ServerProfileBuilder = (context) => {
  const javaMajor = requiredJavaMajor(context.instance.gameVersion);
  return buildDirectJarPlan(context, {
    serverType: "catserver",
    displayName: "CatServer",
    javaMajor,
    jvmArguments: javaMajor >= 17 ? catServerModuleArguments : [],
    programArguments: [],
    eula: "minecraft",
    writesServerProperties: true,
  });
};
