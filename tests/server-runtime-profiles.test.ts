import {
  type JavaInstallationSnapshot,
  type ServerInstanceSnapshot,
  serverRuntimeSupportedTypes,
} from "../packages/contracts/src/index.ts";
import {
  buildServerLaunchPlan,
  parseJvmArguments,
  requiredJavaMajor,
  selectJavaInstallation,
} from "../components/server/runtime/src/profiles/index.ts";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { java17, java21, java25, settings, vanillaInstance } from "./server-runtime-fixtures.ts";

await test("launch helpers select compatible Java and reject reserved JVM arguments", () => {
  assert.equal(requiredJavaMajor("1.16.5"), 8);
  assert.equal(requiredJavaMajor("1.17.1"), 16);
  assert.equal(requiredJavaMajor("1.20.4"), 17);
  assert.equal(requiredJavaMajor("1.20.5"), 21);
  assert.equal(requiredJavaMajor("26.1.2"), 25);
  assert.equal(
    selectJavaInstallation([java21, java17], {
      major: 17,
      exact: false,
      description: "fixture",
    }).id,
    java17.id,
  );
  assert.equal(
    selectJavaInstallation([java17, java21], {
      major: 21,
      exact: true,
      description: "fixture",
    }).id,
    java21.id,
  );
  assert.equal(
    selectJavaInstallation([{ ...java17, disabled: true }, java21], {
      major: 17,
      exact: false,
      description: "fixture",
    }).id,
    java21.id,
  );
  assert.throws(
    () =>
      selectJavaInstallation([{ ...java25, disabled: true }], {
        major: 25,
        exact: true,
        description: "NeoForge 26.1",
      }),
    /未检测到已启用的 Java 25。NeoForge 26\.1 必须使用 Java 25/,
  );
  assert.deepEqual(parseJvmArguments("-Dname=\"Sea Shard\" '-Dliteral=a b'"), [
    "-Dname=Sea Shard",
    "-Dliteral=a b",
  ]);
  assert.throws(
    () =>
      buildServerLaunchPlan(vanillaInstance, {
        ...settings,
        defaultJvmArguments: "-Xmx4G",
      }),
    /must not override/,
  );
  assert.throws(() => parseJvmArguments('"unterminated'), /unterminated quote/);
});

await test("all supported direct and self-bootstrap cores retain the verified runtime target", () => {
  const cases = [
    {
      serverType: "paper",
      gameVersion: "1.21.11-rc3",
      artifact: "paper-1.21.11-rc3-31.jar",
      javaMajor: 21,
      programArguments: ["--nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "purpur",
      gameVersion: "1.21.11",
      artifact: "purpur-1.21.11-2563.jar",
      javaMajor: 21,
      programArguments: ["--nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "folia",
      gameVersion: "1.21.11",
      artifact: "folia-1.21.11-14.jar",
      javaMajor: 21,
      programArguments: ["--nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "fabric",
      gameVersion: "1.21.11",
      artifact: "fabric-1.21.11.jar",
      javaMajor: 21,
      programArguments: ["nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "arclight-neoforge",
      gameVersion: "1.21.1",
      artifact: "arclight-neoforge-1.21.1-1.0.2-SNAPSHOT-9c004d4.jar",
      javaMajor: 21,
      programArguments: ["nogui"],
      stopCommand: "stop",
    },
    {
      serverType: "velocity",
      gameVersion: "3.5.0-SNAPSHOT",
      artifact: "velocity-3.5.0-SNAPSHOT-576.jar",
      javaMajor: 21,
      programArguments: [],
      stopCommand: "end",
    },
    {
      serverType: "nukkitx",
      gameVersion: "Nukkit-Mot",
      artifact: "Nukkit-MOT-SNAPSHOT.jar",
      javaMajor: 17,
      programArguments: [],
      stopCommand: "stop",
    },
  ] as const;

  for (const fixture of cases) {
    const rootPath = `C:/SeaShard/servers/instance-${fixture.serverType}`;
    const instance: ServerInstanceSnapshot = {
      ...vanillaInstance,
      id: `instance-${fixture.serverType}`,
      name: fixture.serverType,
      rootPath,
      coreJarPath: `${rootPath}/${fixture.artifact}`,
      serverType: fixture.serverType,
      gameVersion: fixture.gameVersion,
      coreArtifactFileName: fixture.artifact,
    };
    const plan = buildServerLaunchPlan(instance, settings, "win32");
    assert.equal(plan.serverType, fixture.serverType);
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.workingDirectory, resolve(rootPath));
    assert.equal(plan.stopCommand, fixture.stopCommand);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);
  }
  assert.deepEqual(serverRuntimeSupportedTypes, [
    "vanilla",
    "paper",
    "purpur",
    "folia",
    "fabric",
    "quilt",
    "neoforge",
    "arclight-neoforge",
    "mohist",
    "velocity",
    "nukkitx",
    "arclight-fabric",
    "arclight-forge",
    "banner",
    "bukkit",
    "bungeecord",
    "catserver",
    "leaf",
    "leaves",
    "lightfall",
    "pufferfish",
    "pufferfish_purpur",
    "spigot",
    "spongeforge",
    "spongevanilla",
    "travertine",
    "vanilla-snapshot",
    "youer",
  ]);
});

await test("second-batch profiles preserve per-type launch and stop contracts", () => {
  const cases = [
    {
      serverType: "arclight-fabric",
      gameVersion: "1.21.1",
      artifact: "arclight-fabric-1.21.1.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "arclight-forge",
      gameVersion: "1.21.1",
      artifact: "arclight-forge-1.21.1.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "banner",
      gameVersion: "1.21.1",
      artifact: "banner-1.21.1.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["nogui"],
      eula: "interactive-minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "bukkit",
      gameVersion: "1.21.11",
      artifact: "craftbukkit-1.21.11.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "bungeecord",
      gameVersion: "latest",
      artifact: "BungeeCord.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
      eula: "none",
      writesServerProperties: false,
      stopCommand: "end",
    },
    {
      serverType: "catserver",
      gameVersion: "1.18.2",
      artifact: "CatServer-1.18.2.jar",
      javaMajor: 17,
      jvmArguments: [
        "--add-exports=java.base/sun.security.util=ALL-UNNAMED",
        "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
      ],
      programArguments: [],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "leaf",
      gameVersion: "1.21.11",
      artifact: "leaf-1.21.11.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "leaves",
      gameVersion: "1.21.10",
      artifact: "leaves-1.21.10.jar",
      javaMajor: 21,
      jvmArguments: ["-Dleavesclip.disable.auto-update=true"],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "lightfall",
      gameVersion: "1.20",
      artifact: "lightfall.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
      eula: "none",
      writesServerProperties: false,
      stopCommand: "end",
    },
    {
      serverType: "pufferfish",
      gameVersion: "1.21.10",
      artifact: "pufferfish-1.21.10.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
  ] as const;

  const buildInstance = (
    fixture: {
      readonly serverType: string;
      readonly gameVersion: string;
      readonly artifact: string;
    },
    rootPath = `C:/SeaShard/servers/instance-${fixture.serverType}`,
  ): ServerInstanceSnapshot => ({
    ...vanillaInstance,
    id: `instance-${fixture.serverType}`,
    name: fixture.serverType,
    rootPath,
    coreJarPath: `${rootPath}/${fixture.artifact}`,
    serverType: fixture.serverType,
    gameVersion: fixture.gameVersion,
    coreArtifactFileName: fixture.artifact,
    artifactSha256: "f".repeat(64),
  });

  for (const fixture of cases) {
    const instance = buildInstance(fixture);
    const plan = buildServerLaunchPlan(instance, settings, "win32");
    assert.equal(plan.serverType, fixture.serverType);
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.java.maximumMajor, undefined);
    assert.equal(plan.workingDirectory, resolve(instance.rootPath));
    assert.equal(plan.eula, fixture.eula);
    assert.equal(plan.writesServerProperties, fixture.writesServerProperties);
    assert.equal(plan.stopCommand, fixture.stopCommand);
    assert.deepEqual(plan.requiredRuntimeFiles, [resolve(instance.coreJarPath)]);
    assert.equal(plan.preparation, undefined);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      ...fixture.jvmArguments,
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);
  }

  const historicalCases = [
    {
      serverType: "arclight-fabric",
      gameVersion: "1.20.4",
      artifact: "arclight-fabric-1.20.4.jar",
      javaMajor: 17,
      jvmArguments: [],
      programArguments: ["nogui"],
    },
    {
      serverType: "arclight-forge",
      gameVersion: "1.16.5",
      artifact: "arclight-forge-1.16.5.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: ["nogui"],
    },
    {
      serverType: "banner",
      gameVersion: "1.19.4",
      artifact: "banner-1.19.4.jar",
      javaMajor: 17,
      jvmArguments: [],
      programArguments: ["nogui"],
    },
    {
      serverType: "bukkit",
      gameVersion: "1.8.8",
      artifact: "craftbukkit-1.8.8.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: ["--nogui"],
    },
    {
      serverType: "catserver",
      gameVersion: "1.12.2",
      artifact: "CatServer-1.12.2.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
    },
    {
      serverType: "leaf",
      gameVersion: "1.21.4",
      artifact: "leaf-1.21.4.jar",
      javaMajor: 21,
      jvmArguments: [],
      programArguments: ["--nogui"],
    },
    {
      serverType: "leaves",
      gameVersion: "1.19.4",
      artifact: "leaves-1.19.4.jar",
      javaMajor: 17,
      jvmArguments: ["-Dleavesclip.disable.auto-update=true"],
      programArguments: ["--nogui"],
    },
    {
      serverType: "lightfall",
      gameVersion: "1.18",
      artifact: "lightfall.jar",
      javaMajor: 8,
      jvmArguments: [],
      programArguments: [],
    },
    {
      serverType: "pufferfish",
      gameVersion: "1.17.1",
      artifact: "pufferfish-1.17.1.jar",
      javaMajor: 16,
      jvmArguments: [],
      programArguments: ["--nogui"],
    },
  ] as const;

  for (const fixture of historicalCases) {
    const plan = buildServerLaunchPlan(buildInstance(fixture), settings, "win32");
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.java.maximumMajor, undefined);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      ...fixture.jvmArguments,
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);
  }

  for (const [serverType, character] of [
    ["leaf", "!"],
    ["leaves", "+"],
    ["bukkit", "!"],
    ["pufferfish", "+"],
    ["lightfall", "!"],
  ] as const) {
    const fixture = cases.find((candidate) => candidate.serverType === serverType);
    assert.ok(fixture);
    assert.throws(
      () =>
        buildServerLaunchPlan(
          buildInstance(fixture, `C:/SeaShard/servers/${serverType}${character}invalid`),
          settings,
          "win32",
        ),
      /cannot run from a working directory containing/,
    );
  }

  const bukkit = cases.find((fixture) => fixture.serverType === "bukkit");
  assert.ok(bukkit);
  const bukkitPlan = buildServerLaunchPlan(buildInstance(bukkit), settings, "win32");
  const java26 = {
    ...java25,
    id: "java-26",
    path: "C:/Program Files/Eclipse Adoptium/jdk-26/bin/java.exe",
    javaHome: "C:/Program Files/Eclipse Adoptium/jdk-26",
    version: "26.0.0",
    majorVersion: 26,
  } satisfies JavaInstallationSnapshot;
  assert.equal(selectJavaInstallation([java26, java25], bukkitPlan.java).id, java25.id);
  assert.equal(selectJavaInstallation([java26], bukkitPlan.java).id, java26.id);
});

await test("final-batch profiles reuse one strategy across versions and artifact identities", () => {
  const cases = [
    {
      serverType: "pufferfish_purpur",
      gameVersion: "1.18.2",
      artifact: "pufferfish-purpur-history.jar",
      javaMajor: 17,
      exactJava: true,
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "spigot",
      gameVersion: "1.20.4",
      artifact: "spigot-history.jar",
      javaMajor: 17,
      exactJava: false,
      programArguments: ["--nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "spongevanilla",
      gameVersion: "1.20.4",
      artifact: "spongevanilla-history.jar",
      javaMajor: 17,
      exactJava: true,
      programArguments: [],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
    {
      serverType: "travertine",
      gameVersion: "1.12",
      artifact: "travertine-history.jar",
      javaMajor: 8,
      exactJava: false,
      programArguments: [],
      eula: "none",
      writesServerProperties: false,
      stopCommand: "end",
    },
    {
      serverType: "vanilla-snapshot",
      gameVersion: "1.20.4-snapshot",
      artifact: "snapshot-history.jar",
      javaMajor: 17,
      exactJava: false,
      programArguments: ["nogui"],
      eula: "minecraft",
      writesServerProperties: true,
      stopCommand: "stop",
    },
  ] as const;

  for (const fixture of cases) {
    const rootPath = `C:/SeaShard/servers/instance-${fixture.serverType}`;
    const instance: ServerInstanceSnapshot = {
      ...vanillaInstance,
      id: `instance-${fixture.serverType}`,
      name: fixture.serverType,
      rootPath,
      coreJarPath: `${rootPath}/${fixture.artifact}`,
      serverType: fixture.serverType,
      gameVersion: fixture.gameVersion,
      coreArtifactFileName: "catalog-name-does-not-control-the-profile.jar",
      artifactSha256: "0".repeat(64),
    };
    const plan = buildServerLaunchPlan(instance, settings, "win32");
    assert.equal(plan.java.major, fixture.javaMajor);
    assert.equal(plan.java.exact, fixture.exactJava);
    assert.equal(plan.java.maximumMajor, undefined);
    assert.equal(plan.eula, fixture.eula);
    assert.equal(plan.writesServerProperties, fixture.writesServerProperties);
    assert.equal(plan.stopCommand, fixture.stopCommand);
    assert.deepEqual(plan.arguments, [
      "-XX:+UseG1GC",
      "-Dmotd=Hello World",
      "-Xms1024M",
      "-Xmx2048M",
      "-jar",
      fixture.artifact,
      ...fixture.programArguments,
    ]);

    const alternateIdentity = buildServerLaunchPlan(
      {
        ...instance,
        coreArtifactFileName: "another-catalog-name.jar",
        artifactSha256: undefined,
      },
      settings,
      "win32",
    );
    assert.deepEqual(alternateIdentity.arguments, plan.arguments);
  }

  const vanilla26 = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      gameVersion: "26.1.2",
    },
    settings,
    "win32",
  );
  assert.deepEqual(vanilla26.java, {
    major: 25,
    exact: false,
    description: "Vanilla",
  });

  const youerRoot = "C:/SeaShard/servers/instance-youer-history";
  const youer = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-youer-history",
      name: "Youer history",
      rootPath: youerRoot,
      coreJarPath: `${youerRoot}/youer-history.jar`,
      serverType: "youer",
      gameVersion: "1.20.2",
      coreArtifactFileName: "youer-unlisted-build.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(youer.java, {
    major: 17,
    exact: false,
    description: "Youer 1.20.2",
  });
  assert.deepEqual(youer.preparation?.arguments, [
    "-Xms256M",
    "-Xmx1024M",
    "-jar",
    "youer-history.jar",
    "nogui",
  ]);
  assert.ok(
    youer.preparation?.sentinels.includes(
      resolve(youerRoot, "libraries", "net", "minecraft", "server", "1.20.2", "server-1.20.2.jar"),
    ),
  );
  assert.equal(youer.preparation?.acceptNonZeroWithSentinels, true);
  assert.deepEqual(youer.arguments.slice(-3), ["-jar", "youer-history.jar", "nogui"]);
});

await test("Quilt, NeoForge, and Mohist plans preserve their installer handoff contracts", () => {
  const quiltRoot = "C:/SeaShard/servers/instance-quilt";
  const quilt = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-quilt",
      name: "Quilt",
      rootPath: quiltRoot,
      coreJarPath: `${quiltRoot}/quilt-latest.jar`,
      serverType: "quilt",
      gameVersion: "latest",
      coreArtifactFileName: "quilt-latest.jar",
      artifactSha256: "8b716edc692a2fa1fb78dbc2f432643be1bc6c867e5605f36f691f44257120ca",
    },
    settings,
    "win32",
  );
  assert.deepEqual(quilt.preparation?.arguments, [
    "-jar",
    "quilt-latest.jar",
    "install",
    "server",
    "1.21.11",
    "--download-server",
    "--install-dir=server",
  ]);
  assert.equal(quilt.workingDirectory, resolve(quiltRoot, "server"));
  assert.deepEqual(quilt.arguments, [
    "-XX:+UseG1GC",
    "-Dmotd=Hello World",
    "-Xms1024M",
    "-Xmx2048M",
    "-jar",
    "quilt-server-launch.jar",
    "nogui",
  ]);
  const historicalQuilt = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-quilt-history",
      name: "Quilt history",
      rootPath: quiltRoot,
      coreJarPath: `${quiltRoot}/quilt-history.jar`,
      serverType: "quilt",
      gameVersion: "1.20.4",
      coreArtifactFileName: "quilt-unlisted-installer.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(historicalQuilt.preparation?.arguments, [
    "-jar",
    "quilt-history.jar",
    "install",
    "server",
    "1.20.4",
    "--download-server",
    "--install-dir=server",
  ]);

  const neoForgeRoot = "C:/SeaShard/servers/instance-neoforge";
  const neoForgeArtifact = "neoforge-26.1.0.0-alpha.1+snapshot-1-installer.jar";
  const neoForge = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-neoforge",
      name: "NeoForge",
      rootPath: neoForgeRoot,
      coreJarPath: `${neoForgeRoot}/server.jar`,
      serverType: "neoforge",
      gameVersion: "26.1",
      coreArtifactFileName: neoForgeArtifact,
    },
    settings,
    "win32",
  );
  assert.deepEqual(neoForge.java, {
    major: 25,
    exact: true,
    description: "NeoForge 26.1",
  });
  assert.deepEqual(neoForge.preparation?.arguments, ["-jar", "server.jar", "--installServer", "."]);
  assert.deepEqual(neoForge.arguments, [
    "@user_jvm_args.txt",
    "@libraries\\net\\neoforged\\neoforge\\26.1.0.0-alpha.1+snapshot-1\\win_args.txt",
    "nogui",
  ]);
  assert.deepEqual(neoForge.jvmArgumentFile?.managedArguments, [
    "-XX:+UseG1GC",
    "-Dmotd=Hello World",
    "-Xms1024M",
    "-Xmx2048M",
  ]);
  const historicalNeoForge = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-neoforge-history",
      name: "NeoForge history",
      rootPath: neoForgeRoot,
      coreJarPath: `${neoForgeRoot}/history-installer.jar`,
      serverType: "neoforge",
      gameVersion: "1.21.1",
      coreArtifactFileName: "neoforge-21.1.219-installer.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.deepEqual(historicalNeoForge.java, {
    major: 21,
    exact: true,
    description: "NeoForge 1.21.1",
  });
  assert.deepEqual(historicalNeoForge.arguments, [
    "@user_jvm_args.txt",
    "@libraries\\net\\neoforged\\neoforge\\21.1.219\\win_args.txt",
    "nogui",
  ]);

  const mohistRoot = "C:/SeaShard/servers/instance-mohist";
  const mohist = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-mohist",
      name: "Mohist",
      rootPath: mohistRoot,
      coreJarPath: `${mohistRoot}/mohist-1.20.2-173.jar`,
      serverType: "mohist",
      gameVersion: "1.20.2",
      coreArtifactFileName: "mohist-1.20.2-173.jar",
    },
    settings,
    "win32",
  );
  assert.equal(mohist.preparation?.acceptNonZeroWithSentinels, true);
  assert.deepEqual(mohist.preparation?.arguments, [
    "-Xms256M",
    "-Xmx1024M",
    "-jar",
    "mohist-1.20.2-173.jar",
    "nogui",
  ]);
  assert.deepEqual(mohist.arguments.slice(-3), ["-jar", "mohist-1.20.2-173.jar", "nogui"]);
  const historicalMohist = buildServerLaunchPlan(
    {
      ...vanillaInstance,
      id: "instance-mohist-history",
      name: "Mohist history",
      rootPath: mohistRoot,
      coreJarPath: `${mohistRoot}/mohist-history.jar`,
      serverType: "mohist",
      gameVersion: "1.19.4",
      coreArtifactFileName: "mohist-unlisted-build.jar",
      artifactSha256: undefined,
    },
    settings,
    "win32",
  );
  assert.equal(historicalMohist.java.major, 17);
  assert.deepEqual(historicalMohist.arguments.slice(-3), ["-jar", "mohist-history.jar", "nogui"]);
});
