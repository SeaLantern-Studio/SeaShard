import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopUpdateController,
  isNewerDesktopVersion,
  resolveDesktopUpdateTarget,
} from "../apps/desktop/src/main/desktop-update-controller.ts";

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
  let releaseCheck!: (value: {
    available: boolean;
    latestVersion: string;
    releaseDate: string;
  }) => void;
  let checks = 0;
  const gate = new Promise<{
    available: boolean;
    latestVersion: string;
    releaseDate: string;
  }>((resolve) => {
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
  releaseCheck({
    available: true,
    latestVersion: "1.3.0",
    releaseDate: "2026-08-27T12:00:00.000Z",
  });

  assert.deepEqual(await Promise.all([first, second]), [
    {
      state: "available",
      currentVersion: "1.2.3",
      platform: "windows",
      architecture: "x64",
      packageType: "nsis",
      latestVersion: "1.3.0",
      releaseDate: "2026-08-27T12:00:00.000Z",
    },
    {
      state: "available",
      currentVersion: "1.2.3",
      platform: "windows",
      architecture: "x64",
      packageType: "nsis",
      latestVersion: "1.3.0",
      releaseDate: "2026-08-27T12:00:00.000Z",
    },
  ]);
  assert.deepEqual(states, ["checking", "available"]);
});

await test("desktop updater reports download progress and starts one installer", async () => {
  const controller = new DesktopUpdateController(windowsEnvironment);
  await controller.check(async () => ({ available: true, latestVersion: "1.3.0" }));
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  let downloads = 0;
  let installs = 0;
  const update = controller.installAutomatically(
    () => {
      downloads += 1;
      return downloadGate;
    },
    () => {
      installs += 1;
    },
  );
  const duplicate = controller.installAutomatically(
    async () => {
      downloads += 1;
    },
    () => {
      installs += 1;
    },
  );

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
  assert.equal(installs, 1);
  assert.equal(controller.getSnapshot().state, "installing");
  assert.equal(controller.getSnapshot().progress?.percent, 100);
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
  await controller.check(async () => ({ available: true, latestVersion: "1.3.0" }));
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
