import { buildDirectJarPlan } from "../shared/direct-jar";
import { requiredJavaMajor } from "../shared/java";
import type { ServerProfileBuilder } from "../types";

/** Banner 的许可门从 stdin 读取严格小写 true，不能用普通 eula.txt 预写替代。 */
export const buildBannerPlan: ServerProfileBuilder = (context) =>
  buildDirectJarPlan(context, {
    serverType: "banner",
    displayName: "Banner",
    javaMajor: requiredJavaMajor(context.instance.gameVersion),
    programArguments: ["nogui"],
    eula: "interactive-minecraft",
    writesServerProperties: true,
  });
