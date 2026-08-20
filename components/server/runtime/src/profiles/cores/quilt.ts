import { resolve } from "node:path";
import { minimumJava, requiredJavaMajor } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

/** Quilt 下载产物是安装器；运行目标位于安装器生成的 server 子目录。 */
export const buildQuiltPlan: ServerProfileBuilder = ({ instance, managedJvmArguments }) => {
  const rootPath = resolve(instance.rootPath);
  const runtimeDirectory = resolve(rootPath, "server");
  const runtimeJar = resolve(runtimeDirectory, "quilt-server-launch.jar");
  const serverJar = resolve(runtimeDirectory, "server.jar");
  const sentinels = [runtimeJar, serverJar];
  const minecraftVersion = instance.gameVersion === "latest" ? "1.21.11" : instance.gameVersion;
  const javaMajor = requiredJavaMajor(minecraftVersion);
  return {
    serverType: "quilt",
    displayName: "Quilt",
    java: minimumJava(javaMajor, `Quilt ${minecraftVersion}`),
    preparation: {
      description: `Quilt ${minecraftVersion}`,
      workingDirectory: rootPath,
      arguments: [
        "-jar",
        argumentPath(rootPath, instance.coreJarPath),
        "install",
        "server",
        minecraftVersion!,
        "--download-server",
        "--install-dir=server",
      ],
      sentinels,
      closeStdin: true,
      acceptNonZeroWithSentinels: false,
    },
    workingDirectory: runtimeDirectory,
    requiredRuntimeFiles: sentinels,
    arguments: [...managedJvmArguments, "-jar", "quilt-server-launch.jar", "nogui"],
    eula: "minecraft",
    writesServerProperties: true,
    stopCommand: "stop",
  };
};
