import { resolve } from "node:path";
import { minimumJava, requiredJavaMajor } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

/** Mohist 首次启动先完成内嵌 Forge 补丁，再以用户配置的堆参数正式运行原始胖 JAR。 */
export const buildMohistPlan: ServerProfileBuilder = ({ instance, managedJvmArguments }) => {
  const rootPath = resolve(instance.rootPath);
  const installInfo = resolve(
    rootPath,
    "libraries",
    "com",
    "mohistmc",
    "installation",
    "installInfo",
  );
  const sentinels = [resolve(instance.coreJarPath), installInfo];
  const jarArgument = argumentPath(rootPath, instance.coreJarPath);
  return {
    serverType: "mohist",
    displayName: "Mohist",
    java: minimumJava(requiredJavaMajor(instance.gameVersion), `Mohist ${instance.gameVersion}`),
    preparation: {
      description: `Mohist ${instance.gameVersion} embedded Forge bootstrap`,
      workingDirectory: rootPath,
      // Mohist 准备完成后会另起不继承堆参数的 Java 子进程，父进程使用固定小堆避免首次双份大内存。
      arguments: ["-Xms256M", "-Xmx1024M", "-jar", jarArgument, "nogui"],
      sentinels,
      closeStdin: true,
      acceptNonZeroWithSentinels: true,
    },
    workingDirectory: rootPath,
    requiredRuntimeFiles: sentinels,
    arguments: [...managedJvmArguments, "-jar", jarArgument, "nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    stopCommand: "stop",
  };
};
