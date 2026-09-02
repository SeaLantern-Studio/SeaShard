import assert from "node:assert/strict";
import test from "node:test";
import {
  coordinateDesktopUpdateCompletion,
  DesktopUpdateController,
  isNewerDesktopVersion,
  resolveDesktopUpdateTarget,
  type DesktopUpdateCheckResult,
} from "../apps/desktop/src/main/desktop-update-controller.ts";
import {
  isLocalHostUpdateAvailable,
  parseSeaShardReleaseCatalog,
  resolveLocalHostReleaseAsset,
  resolveHostUpdatePackageType,
} from "../apps/desktop/src/main/local-host-update.ts";
import type {
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
} from "../packages/contracts/src/index.ts";

const windowsEnvironment = {
  currentVersion: "1.2.3",
  isPackaged: true,
  platform: "win32",
  architecture: "x64",
} as const;

await test("desktop updater resolves every packaged desktop target", () => {
  assert.deepEqual(resolveDesktopUpdateTarget(windowsEnvironment), {
    platform: "windows",
    packageType: "nsis",
  });
  assert.deepEqual(
    resolveDesktopUpdateTarget({
      ...windowsEnvironment,
      platform: "linux",
      appImagePath: "/opt/SeaShard.AppImage",
    }),
    { platform: "linux", packageType: "appimage" },
  );
  assert.deepEqual(
    resolveDesktopUpdateTarget({
      ...windowsEnvironment,
      platform: "linux",
      linuxPackageType: "deb",
    }),
    { platform: "linux", packageType: "deb" },
  );
  assert.deepEqual(resolveDesktopUpdateTarget({ ...windowsEnvironment, platform: "darwin" }), {
    platform: "macos",
    packageType: "dmg",
  });
  assert.equal(
    resolveDesktopUpdateTarget({ ...windowsEnvironment, isPackaged: false }).packageType,
    "unsupported",
  );
});

await test("desktop updater coalesces checks and projects an available release", async () => {
  const controller = new DesktopUpdateController(windowsEnvironment);
  const states: string[] = [];
  controller.onSnapshotChanged((snapshot) => states.push(snapshot.state));
  let releaseCheck!: (value: DesktopUpdateCheckResult) => void;
  let checks = 0;
  const gate = new Promise<DesktopUpdateCheckResult>((resolve) => {
    releaseCheck = resolve;
  });
  const check = () => {
    checks += 1;
    return gate;
  };

  const first = controller.check(check);
  const second = controller.check(check);
  assert.equal(controller.getSnapshot().state, "checking");
  assert.equal(checks, 1);
  releaseCheck(
    updateCheckResult(["controller"], {
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      updateAvailable: false,
    }),
  );

  assert.deepEqual(await Promise.all([first, second]), [
    {
      state: "available",
      currentVersion: "1.2.3",
      platform: "windows",
      architecture: "x64",
      packageType: "nsis",
      latestVersion: "1.3.0",
      availableComponents: ["controller"],
      localHost: {
        installed: true,
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: false,
      },
      releaseDate: "2026-08-27T12:00:00.000Z",
    },
    {
      state: "available",
      currentVersion: "1.2.3",
      platform: "windows",
      architecture: "x64",
      packageType: "nsis",
      latestVersion: "1.3.0",
      availableComponents: ["controller"],
      localHost: {
        installed: true,
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: false,
      },
      releaseDate: "2026-08-27T12:00:00.000Z",
    },
  ]);
  assert.deepEqual(states, ["checking", "available"]);
});

await test("desktop updater downloads fully before a separate restart action", async () => {
  const controller = new DesktopUpdateController(windowsEnvironment);
  await controller.check(async () => updateCheckResult(["controller"]));
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  let downloads = 0;
  let installs = 0;
  const update = controller.downloadAutomatically(() => {
    downloads += 1;
    return downloadGate;
  });
  const duplicate = controller.downloadAutomatically(async () => {
    downloads += 1;
  });

  controller.reportProgress({
    percent: 42.4,
    transferredBytes: 424,
    totalBytes: 1_000,
    bytesPerSecond: 128,
  });
  assert.deepEqual(controller.getSnapshot().progress, {
    percent: 42.4,
    transferredBytes: 424,
    totalBytes: 1_000,
    bytesPerSecond: 128,
  });
  assert.equal(downloads, 1);
  releaseDownload();
  await Promise.all([update, duplicate]);
  assert.equal(installs, 0, "a completed download must not restart Electron immediately");
  assert.equal(controller.getSnapshot().state, "restart-required");
  assert.equal(controller.getSnapshot().progress?.percent, 100);

  await controller.installDownloaded(async () => {
    installs += 1;
    return "controller-installing";
  });
  assert.equal(installs, 1);
  assert.equal(controller.getSnapshot().state, "installing");
});

await test("desktop updater waits for startup and complete process exit before install", async () => {
  const instances = [
    createServerInstance("instance-paper", "Paper 生存服"),
    createServerInstance("instance-velocity", "Velocity 代理"),
  ];
  const runtimeStates = new Map<string, ServerRuntimeSnapshot["state"]>([
    ["instance-paper", "running"],
    ["instance-velocity", "starting"],
  ]);
  const startupWaits: string[] = [];
  const stopped: string[] = [];
  const stopWaits: string[] = [];
  const installs: string[] = [];
  const context = {
    listServerInstances: async () => instances,
    readServerRuntime: async (instanceId: string) =>
      ({
        instanceId,
        state: runtimeStates.get(instanceId) ?? "stopped",
      }) satisfies ServerRuntimeSnapshot,
    waitUntilServerStartupSettled: async (instanceId: string) => {
      startupWaits.push(instanceId);
      runtimeStates.set(instanceId, "running");
      return { instanceId, state: "running" } satisfies ServerRuntimeSnapshot;
    },
    stopServerRuntime: async (instanceId: string) => {
      stopped.push(instanceId);
      runtimeStates.set(instanceId, "stopping");
      return { instanceId, state: "stopping" } satisfies ServerRuntimeSnapshot;
    },
    waitUntilServerStopped: async (instanceId: string) => {
      stopWaits.push(instanceId);
      runtimeStates.set(instanceId, "stopped");
      return { instanceId, state: "stopped" } satisfies ServerRuntimeSnapshot;
    },
    install: (afterInstall: "restart" | "close") => {
      installs.push(afterInstall);
    },
  };

  assert.deepEqual(
    await coordinateDesktopUpdateCompletion(context, {
      stopRunningServers: false,
      afterInstall: "restart",
    }),
    {
      outcome: "running-servers",
      runningServers: [
        { instanceId: "instance-paper", name: "Paper 生存服", state: "running" },
        { instanceId: "instance-velocity", name: "Velocity 代理", state: "starting" },
      ],
    },
  );
  assert.deepEqual(stopped, []);
  assert.deepEqual(installs, []);

  assert.equal(
    await coordinateDesktopUpdateCompletion(context, {
      stopRunningServers: true,
      afterInstall: "restart",
    }),
    undefined,
  );
  assert.deepEqual(startupWaits, ["instance-velocity"]);
  assert.deepEqual(stopped, ["instance-paper", "instance-velocity"]);
  assert.deepEqual(stopWaits, ["instance-paper", "instance-velocity"]);
  assert.deepEqual(installs, ["restart"]);
});

await test("desktop updater treats a failed starting server as already settled", async () => {
  const instance = createServerInstance("instance-paper", "Paper 生存服");
  let stops = 0;
  const installs: string[] = [];
  const context = {
    listServerInstances: async () => [instance],
    readServerRuntime: async () =>
      ({ instanceId: instance.id, state: "starting" }) satisfies ServerRuntimeSnapshot,
    waitUntilServerStartupSettled: async () =>
      ({
        instanceId: instance.id,
        state: "failed",
        error: "核心准备失败",
      }) satisfies ServerRuntimeSnapshot,
    stopServerRuntime: async () => {
      stops += 1;
      return { instanceId: instance.id, state: "stopping" } satisfies ServerRuntimeSnapshot;
    },
    waitUntilServerStopped: async () =>
      ({ instanceId: instance.id, state: "stopped" }) satisfies ServerRuntimeSnapshot,
    install: (afterInstall: "restart" | "close") => {
      installs.push(afterInstall);
    },
  };

  assert.equal(
    await coordinateDesktopUpdateCompletion(context, {
      stopRunningServers: true,
      afterInstall: "close",
    }),
    undefined,
  );
  assert.equal(stops, 0);
  assert.deepEqual(installs, ["close"]);
});

await test("desktop updater reports stop failure without consuming the downloaded update", async () => {
  const instance = createServerInstance("instance-paper", "Paper 生存服");
  let installs = 0;
  const context = {
    listServerInstances: async () => [instance],
    readServerRuntime: async () =>
      ({ instanceId: instance.id, state: "running" }) satisfies ServerRuntimeSnapshot,
    waitUntilServerStartupSettled: async () =>
      ({ instanceId: instance.id, state: "running" }) satisfies ServerRuntimeSnapshot,
    stopServerRuntime: async () =>
      ({ instanceId: instance.id, state: "stopping" }) satisfies ServerRuntimeSnapshot,
    waitUntilServerStopped: async () => {
      throw new Error("safe stop timed out");
    },
    install: () => {
      installs += 1;
    },
  };

  assert.deepEqual(
    await coordinateDesktopUpdateCompletion(context, {
      stopRunningServers: true,
      afterInstall: "restart",
    }),
    {
      outcome: "stop-failed",
      failures: [
        {
          instanceId: "instance-paper",
          name: "Paper 生存服",
          reason: "safe stop timed out",
        },
      ],
    },
  );
  assert.equal(installs, 0);
});

await test("macOS updater compares releases and opens one manual download page", async () => {
  assert.equal(isNewerDesktopVersion("1.9.9", "1.10.0"), true);
  assert.equal(isNewerDesktopVersion("1.10.0", "1.10.0"), false);
  assert.equal(isNewerDesktopVersion("2.0.0", "1.10.0"), false);
  assert.throws(() => isNewerDesktopVersion("1.0", "1.1.0"), /无法比较软件版本/u);

  const controller = new DesktopUpdateController({
    ...windowsEnvironment,
    platform: "darwin",
  });
  await controller.check(async () => updateCheckResult(["controller"]));
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let opens = 0;
  const first = controller.openDownloadPage(() => {
    opens += 1;
    return openGate;
  });
  const duplicate = controller.openDownloadPage(async () => {
    opens += 1;
  });

  assert.equal(opens, 1);
  releaseOpen();
  await Promise.all([first, duplicate]);
  assert.equal(controller.getSnapshot().state, "available");
});

await test("desktop updater exposes a retryable error after a failed check", async () => {
  const controller = new DesktopUpdateController(windowsEnvironment);
  await assert.rejects(
    controller.check(async () => {
      throw new Error("release metadata unavailable");
    }),
    /release metadata unavailable/u,
  );
  assert.deepEqual(controller.getSnapshot(), {
    state: "error",
    currentVersion: "1.2.3",
    platform: "windows",
    architecture: "x64",
    packageType: "nsis",
    error: "release metadata unavailable",
  });
});

await test("Host-only update stays in Controller and consumes only the Host component", async () => {
  const controller = new DesktopUpdateController(windowsEnvironment);
  await controller.check(async () =>
    updateCheckResult(["local-host"], {
      currentVersion: "1.1.0",
      latestVersion: "1.3.0",
      updateAvailable: true,
    }),
  );

  await controller.downloadAutomatically(async () => undefined);
  assert.equal(controller.getSnapshot().state, "host-install-ready");
  await controller.installDownloaded(async () => "host-completed");
  assert.deepEqual(controller.getSnapshot(), {
    state: "current",
    currentVersion: "1.2.3",
    platform: "windows",
    architecture: "x64",
    packageType: "nsis",
    latestVersion: "1.3.0",
    availableComponents: [],
    localHost: {
      installed: true,
      currentVersion: "1.3.0",
      latestVersion: "1.3.0",
      updateAvailable: false,
    },
    releaseDate: "2026-08-27T12:00:00.000Z",
  });
});

await test("Controller and Host updates remain separate through one safe-stop gate", async () => {
  const controller = new DesktopUpdateController(windowsEnvironment);
  await controller.check(async () =>
    updateCheckResult(["controller", "local-host"], {
      currentVersion: "1.1.0",
      latestVersion: "1.3.0",
      updateAvailable: true,
    }),
  );
  const downloads: string[] = [];
  await controller.downloadAutomatically(async () => {
    controller.setDownloadComponent("local-host");
    downloads.push(controller.getSnapshot().downloadComponent!);
    controller.setDownloadComponent("controller");
    downloads.push(controller.getSnapshot().downloadComponent!);
  });

  assert.deepEqual(downloads, ["local-host", "controller"]);
  assert.equal(controller.getSnapshot().state, "restart-required");
  await controller.installDownloaded(async () => "controller-installing");
  assert.equal(controller.getSnapshot().state, "installing");
});

await test("static Release catalog selects verified Host assets and never downgrades", () => {
  const digest = "a".repeat(64);
  const release = parseSeaShardReleaseCatalog({
    schemaVersion: 1,
    version: "1.3.0",
    tag: "v1.3.0",
    assets: [
      {
        name: "SeaShard-Host-linux-x64.deb",
        size: 42,
        sha256: digest,
        downloadUrl:
          "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.3.0/SeaShard-Host-linux-x64.deb",
      },
      {
        name: "SeaShard-Host-linux-x64.AppImage",
        size: 84,
        sha256: digest,
        downloadUrl:
          "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.3.0/SeaShard-Host-linux-x64.AppImage",
      },
    ],
  });
  assert.equal(
    resolveLocalHostReleaseAsset(release, {
      platform: "linux",
      architecture: "x64",
      packageType: "deb",
    }).name,
    "SeaShard-Host-linux-x64.deb",
  );
  assert.equal(
    resolveLocalHostReleaseAsset(release, {
      platform: "linux",
      architecture: "x64",
      packageType: "appimage",
    }).name,
    "SeaShard-Host-linux-x64.AppImage",
  );
  assert.equal(
    resolveLocalHostReleaseAsset(release, {
      platform: "linux",
      architecture: "x64",
      packageType: "deb",
    }).sha256,
    digest,
  );
  assert.equal(isLocalHostUpdateAvailable(true, undefined, "1.3.0"), true);
  assert.equal(isLocalHostUpdateAvailable(true, "1.2.9", "1.3.0"), true);
  assert.equal(isLocalHostUpdateAvailable(true, "1.3.0", "1.3.0"), false);
  assert.equal(isLocalHostUpdateAvailable(true, "1.4.0", "1.3.0"), false);
  assert.equal(isLocalHostUpdateAvailable(false, undefined, "1.3.0"), false);
});

await test("static Release catalog rejects assets outside its immutable tag", () => {
  assert.throws(
    () =>
      parseSeaShardReleaseCatalog({
        schemaVersion: 1,
        version: "1.3.0",
        tag: "v1.3.0",
        assets: [
          {
            name: "SeaShard-Host-linux-x64.deb",
            size: 42,
            sha256: "a".repeat(64),
            downloadUrl:
              "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.2.0/SeaShard-Host-linux-x64.deb",
          },
        ],
      }),
    /资产地址无效/u,
  );
});

await test("mixed Linux installs select the Host package type independently", () => {
  assert.equal(
    resolveHostUpdatePackageType({
      platform: "linux",
      descriptorPackageType: "deb",
      legacyEnvironment: { APPIMAGE: "/controller/SeaShard.AppImage" },
    }),
    "deb",
  );
  assert.equal(
    resolveHostUpdatePackageType({
      platform: "linux",
      descriptorPackageType: "appimage",
      legacyExecutablePath: "/opt/SeaShard/seashard-host",
    }),
    "appimage",
  );
  assert.equal(
    resolveHostUpdatePackageType({
      platform: "linux",
      legacyExecutablePath: "/opt/SeaShard Host/seashard-host",
      installationKind: "standalone",
    }),
    "deb",
  );
  assert.equal(
    resolveHostUpdatePackageType({
      platform: "linux",
      legacyEnvironment: {
        SEASHARD_HOST_INSTALLED_EXECUTABLE: "/home/test/.local/share/SeaShard/host/runtime/AppRun",
      },
    }),
    "appimage",
  );
  assert.equal(
    resolveHostUpdatePackageType({
      platform: "linux",
      installationKind: "standalone",
    }),
    undefined,
  );
});

function updateCheckResult(
  availableComponents: DesktopUpdateCheckResult["availableComponents"],
  localHost: Omit<DesktopUpdateCheckResult["localHost"], "installed"> = {
    currentVersion: "1.3.0",
    latestVersion: "1.3.0",
    updateAvailable: false,
  },
): DesktopUpdateCheckResult {
  return {
    latestVersion: "1.3.0",
    availableComponents,
    localHost: { installed: true, ...localHost },
    releaseDate: "2026-08-27T12:00:00.000Z",
  };
}

function createServerInstance(id: string, name: string): ServerInstanceSnapshot {
  return {
    id,
    name,
    rootPath: `C:/SeaShard/${id}`,
    coreJarPath: `C:/SeaShard/${id}/server.jar`,
    storageMode: "managed",
    source: "downloaded",
    modLoader: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}
