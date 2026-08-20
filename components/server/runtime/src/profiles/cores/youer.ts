import { resolve } from "node:path";
import { minimumJava, requiredJavaMajor } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

/** Youer 各版本首次运行生成内嵌 NeoForge/Paper 运行时，永久入口仍为原始胖 JAR。 */
export const buildYouerPlan: ServerProfileBuilder = ({ instance, managedJvmArguments }) => {
  const gameVersion = instance.gameVersion;
  const javaMajor = requiredJavaMajor(gameVersion);
  const rootPath = resolve(instance.rootPath);
  const jarArgument = argumentPath(rootPath, instance.coreJarPath);
  const sentinels = [
    resolve(instance.coreJarPath),
    resolve(rootPath, "libraries", "com", "mohistmc", "installation", "installInfo"),
    resolve(rootPath, "libraries", "com", "mohistmc", "installation", "data", "paper-remap.jar"),
    resolve(
      rootPath,
      "libraries",
      "net",
      "minecraft",
      "server",
      gameVersion!,
      `server-${gameVersion}.jar`,
    ),
  ];
  return {
    serverType: "youer",
    displayName: "Youer",
    java: minimumJava(javaMajor, `Youer ${gameVersion}`),
    preparation: {
      description: `Youer ${gameVersion} embedded NeoForge/Paper bootstrap`,
      workingDirectory: rootPath,
      // 准备进程固定小堆，避免其内嵌子进程与正式服务器同时占用用户配置的大堆。
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
