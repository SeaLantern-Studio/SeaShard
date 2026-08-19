import { basename, resolve } from "node:path";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

const supportedNeoForgeVersion = "26.1.0.0-alpha.1+snapshot-1";

/** NeoForge 安装后必须通过生成的 JVM 参数文件启动，不能直接运行 installer 或 universal JAR。 */
export const buildNeoForgePlan: ServerProfileBuilder = ({
  instance,
  managedJvmArguments,
  platform,
}) => {
  const artifactName = instance.coreArtifactFileName ?? basename(instance.coreJarPath);
  const version = /^neoforge-(.+)-installer\.jar$/iu.exec(artifactName)?.[1];
  if (version !== supportedNeoForgeVersion) {
    throw new Error(`NeoForge installer ${artifactName} is not supported by the verified profile`);
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
      major: 25,
      exact: true,
      description: "NeoForge 26.1",
    },
    preparation: {
      description: `NeoForge ${version}`,
      workingDirectory: rootPath,
      arguments: ["-jar", argumentPath(rootPath, instance.coreJarPath), "--installServer", "."],
      sentinels,
      closeStdin: true,
      acceptNonZeroWithSentinels: false,
      classPathArgumentFile: platformArgumentFile,
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
