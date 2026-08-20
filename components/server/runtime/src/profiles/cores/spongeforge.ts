import { basename, resolve } from "node:path";
import { exactJava, requiredJavaMajor } from "../shared/java";
import { argumentPath } from "../shared/paths";
import type { ServerProfileBuilder } from "../types";

const spongeForgeArtifactPattern = /^spongeforge-(.+)-(\d+\.\d+\.\d+)_(.+)-universal\.jar$/iu;

/** SpongeForge 是 Forge 模组：按产物元数据派生 Forge 版本，安装标准 Forge 后放入 mods。 */
export const buildSpongeForgePlan: ServerProfileBuilder = ({
  instance,
  managedJvmArguments,
  platform,
}) => {
  const spongeArtifact = instance.coreArtifactFileName ?? basename(instance.coreJarPath);
  const artifactMatch = spongeForgeArtifactPattern.exec(spongeArtifact);
  const minecraftVersion = artifactMatch?.[1];
  const forgeBuildVersion = artifactMatch?.[2];
  const spongeVersion = artifactMatch?.[3];
  if (!minecraftVersion || !forgeBuildVersion || !spongeVersion) {
    throw new Error(`cannot determine Forge version from SpongeForge artifact ${spongeArtifact}`);
  }
  if (instance.gameVersion && instance.gameVersion !== minecraftVersion) {
    throw new Error(
      `SpongeForge artifact ${spongeArtifact} does not match Minecraft ${instance.gameVersion}`,
    );
  }

  const forgeVersion = `${minecraftVersion}-${forgeBuildVersion}`;
  const forgeInstallerArtifact = `forge-${forgeVersion}-installer.jar`;
  const forgeInstallerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVersion}/${forgeInstallerArtifact}`;
  const rootPath = resolve(instance.rootPath);
  const forgeInstallerPath = resolve(rootPath, forgeInstallerArtifact);
  const forgeInstallerSha256Path = `${forgeInstallerPath}.sha256`;
  const forgeDirectory = resolve(
    rootPath,
    "libraries",
    "net",
    "minecraftforge",
    "forge",
    forgeVersion,
  );
  const platformArgumentFile = resolve(
    forgeDirectory,
    platform === "win32" ? "win_args.txt" : "unix_args.txt",
  );
  const userJvmArgumentFile = resolve(rootPath, "user_jvm_args.txt");
  const spongeModPath = resolve(rootPath, "mods", spongeArtifact);
  const sentinels = [
    resolve(rootPath, platform === "win32" ? "run.bat" : "run.sh"),
    userJvmArgumentFile,
    platformArgumentFile,
    resolve(rootPath, `forge-${forgeVersion}-shim.jar`),
    resolve(forgeDirectory, `forge-${forgeVersion}-universal.jar`),
    resolve(forgeDirectory, `forge-${forgeVersion}-server.jar`),
    resolve(
      rootPath,
      "libraries",
      "net",
      "minecraft",
      "server",
      minecraftVersion,
      `server-${minecraftVersion}-bundled.jar`,
    ),
    spongeModPath,
  ];
  return {
    serverType: "spongeforge",
    displayName: "SpongeForge",
    java: exactJava(
      requiredJavaMajor(minecraftVersion),
      `SpongeForge ${minecraftVersion} / Forge ${forgeBuildVersion}`,
    ),
    preparation: {
      description: `Forge ${forgeVersion} with SpongeForge ${spongeVersion.replaceAll("_", " ")}`,
      workingDirectory: rootPath,
      arguments: ["-jar", argumentPath(rootPath, forgeInstallerPath), "--installServer", "."],
      sentinels,
      closeStdin: true,
      acceptNonZeroWithSentinels: false,
      runtimeArgumentFile: platformArgumentFile,
      downloads: [
        {
          url: forgeInstallerUrl,
          path: forgeInstallerPath,
          sha256Url: `${forgeInstallerUrl}.sha256`,
          sha256Path: forgeInstallerSha256Path,
        },
      ],
      copies: [
        {
          source: resolve(instance.coreJarPath),
          target: spongeModPath,
        },
      ],
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
