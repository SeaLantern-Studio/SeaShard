import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareServerLocalHost,
  resolveServerBundledHostInstaller,
} from "../apps/server/src/host-setup.ts";
import { resolveServerControllerPaths } from "../apps/server/src/paths.ts";
import { registerStandaloneHost } from "../packages/host-installation/src/index.ts";

await test("Server and Desktop resolve the same Windows shared data roots", () => {
  assert.deepEqual(
    resolveServerControllerPaths({
      environment: { APPDATA: "C:\\Users\\sea\\AppData\\Roaming" },
      platform: "win32",
      homeDirectory: "C:\\Users\\sea",
    }),
    {
      userDataRoot: "C:\\Users\\sea\\AppData\\Roaming\\SeaShard",
      sharedControllerDataRoot: "C:\\Users\\sea\\AppData\\Roaming\\SeaShard\\controller",
      hostDataRoot: "C:\\Users\\sea\\AppData\\Roaming\\SeaShard\\core",
      controllerDataRoot: "C:\\Users\\sea\\AppData\\Roaming\\SeaShard\\server-controller",
      logFile:
        "C:\\Users\\sea\\AppData\\Roaming\\SeaShard\\server-controller\\server-controller.log",
    },
  );
});

await test("Server follows XDG paths and only isolates instance data", () => {
  assert.deepEqual(
    resolveServerControllerPaths({
      environment: { XDG_CONFIG_HOME: "/home/sea/.config" },
      platform: "linux",
      homeDirectory: "/home/sea",
    }),
    {
      userDataRoot: "/home/sea/.config/SeaShard",
      sharedControllerDataRoot: "/home/sea/.config/SeaShard/controller",
      hostDataRoot: "/home/sea/.config/SeaShard/core",
      controllerDataRoot: "/home/sea/.config/SeaShard/server-controller",
      logFile: "/home/sea/.config/SeaShard/server-controller/server-controller.log",
    },
  );
});

await test("Server follows macOS Application Support paths", () => {
  assert.deepEqual(
    resolveServerControllerPaths({
      environment: {},
      platform: "darwin",
      homeDirectory: "/Users/sea",
    }),
    {
      userDataRoot: "/Users/sea/Library/Application Support/SeaShard",
      sharedControllerDataRoot: "/Users/sea/Library/Application Support/SeaShard/controller",
      hostDataRoot: "/Users/sea/Library/Application Support/SeaShard/core",
      controllerDataRoot: "/Users/sea/Library/Application Support/SeaShard/server-controller",
      logFile:
        "/Users/sea/Library/Application Support/SeaShard/server-controller/server-controller.log",
    },
  );
});

await test("Shared, Server-private, and Host roots can be configured independently", () => {
  const paths = resolveServerControllerPaths({
    environment: {
      SEASHARD_DATA_DIR: "/tmp/seashard-host",
      SEASHARD_SERVER_DATA_DIR: "/tmp/seashard-server",
    },
    platform: "linux",
    homeDirectory: "/home/sea",
  });
  assert.equal(paths.hostDataRoot, "/tmp/seashard-host");
  assert.equal(paths.sharedControllerDataRoot, "/tmp/seashard-host/controller");
  assert.equal(paths.controllerDataRoot, "/tmp/seashard-server");
});

await test("Server skips its installer when the current user already has Host", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-host-"));
  try {
    await registerStandaloneHost(dataRoot, "appimage");
    assert.equal(
      await prepareServerLocalHost({
        dataRoot,
        installerRoot: join(dataRoot, "missing-installer"),
        platform: "linux",
      }),
      "existing",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Server development can run before a Host installer has been staged", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-host-"));
  try {
    assert.equal(
      await prepareServerLocalHost({
        dataRoot,
        installerRoot: join(dataRoot, "missing-installer"),
        platform: "win32",
        allowMissingInstaller: true,
      }),
      "development-missing",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Server recognizes the staged Windows Host installer", async () => {
  const installerRoot = await mkdtemp(join(tmpdir(), "seashard-server-installer-"));
  try {
    const installerPath = join(installerRoot, "SeaShardHostSetup.exe");
    await writeFile(installerPath, "fixture");
    assert.deepEqual(resolveServerBundledHostInstaller(installerRoot, "win32"), {
      platform: "win32",
      installerPath,
    });
  } finally {
    await rm(installerRoot, { recursive: true, force: true });
  }
});

await test("Server recognizes the staged macOS Host application", async () => {
  const installerRoot = await mkdtemp(join(tmpdir(), "seashard-server-macos-installer-"));
  try {
    const installerPath = join(installerRoot, "SeaShardHost.app");
    await mkdir(installerPath);
    assert.deepEqual(resolveServerBundledHostInstaller(installerRoot, "darwin"), {
      platform: "darwin",
      installerPath,
      installerType: "application",
    });
  } finally {
    await rm(installerRoot, { recursive: true, force: true });
  }
});
