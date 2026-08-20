import { basename, resolve } from "node:path";
import { requiredJavaMajor } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

/** NeoForge 安装后必须通过生成的 JVM 参数文件启动，不能直接运行 installer 或 universal JAR。 */
export const buildNeoForgePlan: ServerProfileBuilder = ({
  instance,
  managedJvmArguments,
  platform,
}) => {
  const artifactName = instance.coreArtifactFileName ?? basename(instance.coreJarPath);
  const version = /^neoforge-(.+)-installer\.jar$/iu.exec(artifactName)?.[1];
  if (!version) {
    throw new Error(`cannot determine NeoForge version from installer artifact ${artifactName}`);
  }
  const rootPath = resolve(instance.rootPath);
  const versionDirectory = resolve(rootPath, "libraries", "net", "neoforged", "neoforge", version);
  const platformArgumentFile = resolve(
    versionDirectory,
    platform === "win32" ? "win_args.txt" : "unix_args.txt",
  );
  const userJvmArgumentFile = resolve(rootPath, "user_jvm_args.txt");
  const sentinels = [
    resolve(rootPath, platform === "win32" ? "run.bat" : "run.sh"),
    userJvmArgumentFile,
    platformArgumentFile,
    resolve(versionDirectory, `neoforge-${version}-universal.jar`),
    resolve(
      rootPath,
      "libraries",
      "net",
      "neoforged",
      "minecraft-server-patched",
      version,
      `minecraft-server-patched-${version}.jar`,
    ),
  ];
  return {
    serverType: "neoforge",
    displayName: "NeoForge",
    java: {
      major: requiredJavaMajor(instance.gameVersion),
      exact: true,
      description: `NeoForge ${instance.gameVersion}`,
    },
    preparation: {
      description: `NeoForge ${version}`,
      workingDirectory: rootPath,
      arguments: ["-jar", argumentPath(rootPath, instance.coreJarPath), "--installServer", "."],
      sentinels,
      closeStdin: true,
      acceptNonZeroWithSentinels: false,
      runtimeArgumentFile: platformArgumentFile,
    },
    workingDirectory: rootPath,
    requiredRuntimeFiles: sentinels,
    arguments: [
      `@${argumentPath(rootPath, userJvmArgumentFile)}`,
      `@${argumentPath(rootPath, platformArgumentFile)}`,
      "nogui",
    ],
    jvmArgumentFile: {
      path: userJvmArgumentFile,
      managedArguments: managedJvmArguments,
    },
    eula: "minecraft",
    writesServerProperties: true,
    stopCommand: "stop",
  };
};
