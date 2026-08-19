import { resolve } from "node:path";
import { minimumJava } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

const quiltInstallerSha256 = "8b716edc692a2fa1fb78dbc2f432643be1bc6c867e5605f36f691f44257120ca";
const quiltMinecraftVersion = "1.21.11";
const quiltLoaderVersion = "0.30.0";

/** Quilt 下载产物是安装器；运行目标位于安装器生成的 server 子目录。 */
export const buildQuiltPlan: ServerProfileBuilder = ({ instance, managedJvmArguments }) => {
  if (instance.artifactSha256 !== quiltInstallerSha256) {
    throw new Error("this Quilt installer artifact is not the verified startup profile");
  }
  const rootPath = resolve(instance.rootPath);
  const runtimeDirectory = resolve(rootPath, "server");
  const runtimeJar = resolve(runtimeDirectory, "quilt-server-launch.jar");
  const serverJar = resolve(runtimeDirectory, "server.jar");
  const libraryPaths = [
    `org/quiltmc/quilt-json5/1.0.4+final/quilt-json5-1.0.4+final.jar`,
    `org/quiltmc/hashed/${quiltMinecraftVersion}/hashed-${quiltMinecraftVersion}.jar`,
    `net/fabricmc/intermediary/${quiltMinecraftVersion}/intermediary-${quiltMinecraftVersion}.jar`,
    "net/fabricmc/sponge-mixin/0.17.2+mixin.0.8.7/sponge-mixin-0.17.2+mixin.0.8.7.jar",
    "org/ow2/asm/asm-util/9.9/asm-util-9.9.jar",
    "org/ow2/asm/asm/9.9/asm-9.9.jar",
    "org/ow2/asm/asm-analysis/9.9/asm-analysis-9.9.jar",
    "org/ow2/asm/asm-tree/9.9/asm-tree-9.9.jar",
    "org/ow2/asm/asm-commons/9.9/asm-commons-9.9.jar",
    `org/quiltmc/quilt-loader/${quiltLoaderVersion}/quilt-loader-${quiltLoaderVersion}.jar`,
    "org/quiltmc/quilt-config/1.3.3/quilt-config-1.3.3.jar",
  ].map((path) => resolve(runtimeDirectory, "libraries", path));
  const sentinels = [runtimeJar, serverJar, ...libraryPaths];
  return {
    serverType: "quilt",
    displayName: "Quilt",
    java: minimumJava(21, "Quilt 1.21.11"),
    preparation: {
      description: `Quilt ${quiltMinecraftVersion} / Loader ${quiltLoaderVersion}`,
      workingDirectory: rootPath,
      arguments: [
        "-jar",
        argumentPath(rootPath, instance.coreJarPath),
        "install",
        "server",
        quiltMinecraftVersion,
        quiltLoaderVersion,
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
