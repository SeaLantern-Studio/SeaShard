import { basename, resolve } from "node:path";
import { minimumJava } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

const supportedMohistArtifact = "mohist-1.20.2-173.jar";

/** Mohist 首次启动先完成内嵌 Forge 补丁，再以用户配置的堆参数正式运行原始胖 JAR。 */
export const buildMohistPlan: ServerProfileBuilder = ({ instance, managedJvmArguments }) => {
  const artifactName = instance.coreArtifactFileName ?? basename(instance.coreJarPath);
  if (instance.gameVersion !== "1.20.2" || artifactName !== supportedMohistArtifact) {
    throw new Error(
      `Mohist ${instance.gameVersion ?? "<missing>"} artifact ${artifactName} is not supported by this profile`,
    );
  }
  const rootPath = resolve(instance.rootPath);
  const forgeServer = resolve(
    rootPath,
    "libraries",
    "net",
    "minecraftforge",
    "forge",
    "1.20.2-48.1.0",
    "forge-1.20.2-48.1.0-server.jar",
  );
  const installInfo = resolve(
    rootPath,
    "libraries",
    "com",
    "mohistmc",
    "installation",
    "installInfo",
  );
  const sentinels = [resolve(instance.coreJarPath), installInfo, forgeServer];
  const jarArgument = argumentPath(rootPath, instance.coreJarPath);
  return {
    serverType: "mohist",
    displayName: "Mohist",
    java: minimumJava(17, "Mohist 1.20.2"),
    preparation: {
      description: "Mohist 1.20.2 embedded Forge bootstrap",
      workingDirectory: rootPath,
      // Mohist 准备完成后会另起不继承堆参数的 Java 子进程，父进程使用固定小堆避免首次双份大内存。
      arguments: ["-Xms256M", "-Xmx1024M", "-jar", jarArgument, "nogui"],
      sentinels,
      closeStdin: true,
      acceptNonZeroWithSentinels: true,
      hashManifest: {
        path: installInfo,
        algorithm: "md5",
        targets: [forgeServer, resolve(instance.coreJarPath)],
      },
    },
    workingDirectory: rootPath,
    requiredRuntimeFiles: sentinels,
    arguments: [...managedJvmArguments, "-jar", jarArgument, "nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    stopCommand: "stop",
  };
};
