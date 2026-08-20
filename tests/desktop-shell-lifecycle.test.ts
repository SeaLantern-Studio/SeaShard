import {
  desktopChannels,
  type DesktopClientBootstrap,
  serverCoreIconScheme,
} from "../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  clientEntries,
  createDesktopShellHarness,
  paperArtifact,
  serverConsoleLine,
  serverCoreTypes,
  serverModFilters,
  serverModProjectDetails,
  serverModSearchRequest,
  serverModSearchResult,
  snapshot,
} from "./desktop-shell-fixtures.ts";

await test("desktop shell owns the primary window and releases its lifecycle", async () => {
  const harness = await createDesktopShellHarness();
  const { runtime, shell } = harness;
  await Promise.all([shell.service.openPrimary(), shell.service.openPrimary()]);
  assert.equal(runtime.windows.length, 1, "concurrent opens must share one primary window");
  const first = runtime.windows[0];
  assert.equal(first.loadedFile, "C:/SeaShard/index.html");
  assert.equal(first.options.width, 1200);
  assert.equal(first.options.height, 720);
  assert.equal(first.options.minWidth, 1000);
  assert.equal(first.options.minHeight, 625);
  assert.equal(first.options.titleBarStyle, "hidden");
  assert.deepEqual(first.options.webPreferences, {
    preload: "C:/SeaShard/preload.cjs",
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  assert.deepEqual(first.windowOpenHandler?.({ url: "http://untrusted.invalid" }), {
    action: "deny",
  });
  assert.deepEqual(
    first.windowOpenHandler?.({
      url: "https://user:password@untrusted.invalid/private",
    }),
    { action: "deny" },
  );
  assert.deepEqual(runtime.openedExternalUrls, []);
  assert.deepEqual(
    first.windowOpenHandler?.({
      url: "https://github.com/malte0811/FerriteCore/blob/main/summary.md#memory",
    }),
    { action: "deny" },
  );
  assert.deepEqual(
    first.windowOpenHandler?.({
      url: "https://search.mcmod.cn/s?key=No%2BChat%2BReports&mold=0",
    }),
    { action: "deny" },
  );
  assert.deepEqual(runtime.openedExternalUrls, [
    "https://github.com/malte0811/FerriteCore/blob/main/summary.md#memory",
    "https://search.mcmod.cn/s?key=No%2BChat%2BReports&mold=0",
  ]);
  let permissionAllowed: boolean | undefined;
  first.permissionRequestHandler?.(undefined, "notifications", (allowed) => {
    permissionAllowed = allowed;
  });
  assert.equal(permissionAllowed, false);

  assert.equal(await runtime.invoke(desktopChannels.windowMinimize, 1), undefined);
  assert.equal(first.minimized, true);
  assert.equal(await runtime.invoke(desktopChannels.windowToggleMaximize, 1), true);
  assert.equal(first.maximized, true);
  assert.equal(await runtime.invoke(desktopChannels.windowToggleMaximize, 1), false);
  assert.equal(first.maximized, false);

  runtime.directorySelection = "C:/SeaShard/resources";
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadListTasks, 999),
    /request rejected/,
  );
  assert.equal(await runtime.invoke(desktopChannels.runtimeSnapshot, 1), snapshot);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 999), /request rejected/);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverCoreTypes, 1), serverCoreTypes);
  await assert.rejects(runtime.invoke(desktopChannels.serverCoreTypes, 999), /request rejected/);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverCoreVersions, 1, "paper"), [
    "1.21.1",
  ]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreVersions, 1, ""),
    /non-empty string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreVersions, 999, "paper"),
    /request rejected/,
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreArtifacts, 1, "paper", "1.21.1"),
    [paperArtifact],
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreArtifacts, 1, "paper", ""),
    /non-empty string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreArtifacts, 999, "paper", "1.21.1"),
    /request rejected/,
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.serverModFilters, 1), serverModFilters);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverModSearch, 1, serverModSearchRequest),
    serverModSearchResult,
  );
  assert.deepEqual(harness.serverModSearchRequests, [serverModSearchRequest]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverModProjectDetails, 1, "server-mod-1"),
    serverModProjectDetails,
  );
  assert.deepEqual(harness.serverModDetailProjectIds, ["server-mod-1"]);
  const modInstallRequest = {
    projectId: "server-mod-1",
    versionId: "version-neoforge-1",
    instanceId: "instance-paper",
  } as const;
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverModInstallToInstance, 1, modInstallRequest),
    {
      projectId: "server-mod-1",
      versionId: "version-neoforge-1",
      fileName: "server-tools-neoforge-1.21.1.jar",
      destination: "instance",
      instanceId: "instance-paper",
      downloadedBytes: 1_024,
    },
  );
  assert.deepEqual(harness.installedServerMods, [
    { ...modInstallRequest, connections: harness.serverSettings.defaultDownloadConnections },
  ]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverModDownloadSaveAs, 1, {
      projectId: "server-mod-1",
      versionId: "version-neoforge-1",
    }),
    {
      projectId: "server-mod-1",
      versionId: "version-neoforge-1",
      fileName: "server-tools-neoforge-1.21.1.jar",
      destination: "directory",
      downloadedBytes: 1_024,
    },
  );
  assert.deepEqual(harness.savedServerMods, [
    {
      projectId: "server-mod-1",
      versionId: "version-neoforge-1",
      destinationDirectory: "C:/SeaShard/resources",
      connections: harness.serverSettings.defaultDownloadConnections,
    },
  ]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverModInstallToInstance, 1, {
      ...modInstallRequest,
      versionId: "../invalid",
    }),
    /version ID is invalid/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverModInstallToInstance, 999, modInstallRequest),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverModProjectDetails, 1, "../invalid"),
    /project ID is invalid/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverModSearch, 1, {
      ...serverModSearchRequest,
      limit: 51,
    }),
    /limit must be between/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverModFilters, 999), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverModSearch, 999, serverModSearchRequest),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverModProjectDetails, 999, "server-mod-1"),
    /request rejected/,
  );
  assert.deepEqual(harness.readySnapshots, []);
  assert.deepEqual(await runtime.invoke(desktopChannels.clientBootstrap, 1), {
    protocolVersion: 1,
    ...clientEntries,
    clientSession: {
      id: "desktop-primary:1",
      target: "desktop",
      surface: "primary",
    },
  } satisfies DesktopClientBootstrap);
  await assert.rejects(runtime.invoke(desktopChannels.clientBootstrap, 999), /request rejected/);
  assert.equal(await runtime.invoke(desktopChannels.rendererReady, 1), undefined);
  assert.deepEqual(harness.readySnapshots, [snapshot]);
  await assert.rejects(runtime.invoke(desktopChannels.rendererReady, 999), /request rejected/);
  const updatedEntries = { ...clientEntries, revision: 2 };
  harness.clientEntryListener?.(updatedEntries);
  harness.serverConsoleListener?.(serverConsoleLine);
  assert.deepEqual(first.sent, [
    {
      channel: desktopChannels.clientBootstrapChanged,
      payload: {
        protocolVersion: 1,
        ...updatedEntries,
        clientSession: {
          id: "desktop-primary:1",
          target: "desktop",
          surface: "primary",
        },
      },
    },
    {
      channel: desktopChannels.serverRuntimeConsoleLine,
      payload: serverConsoleLine,
    },
  ]);

  first.emit("ready-to-show");
  assert.equal(first.shown, true);
  await runtime.invoke(desktopChannels.windowClose, 1);
  assert.equal(first.closeCount, 1);
  runtime.emit("activate");
  assert.equal(runtime.windows.length, 2, "activate must recreate a closed primary window");

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 1);
  await shell.dispose();
  assert.equal(runtime.windows[1].destroyed, true);
  assert.equal(runtime.listenerCount("activate"), 0);
  assert.equal(runtime.listenerCount("window-all-closed"), 0);
  assert.equal(runtime.handlers.has(desktopChannels.runtimeSnapshot), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreTypes), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreVersions), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreArtifacts), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverModFilters), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverModSearch), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverModProjectDetails), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverModInstallToInstance), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverModDownloadSaveAs), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverSettingsGet), false);
  assert.equal(
    runtime.handlers.has(desktopChannels.serverSettingsSetResourceDownloadDirectory),
    false,
  );
  assert.equal(
    runtime.handlers.has(desktopChannels.serverSettingsSetDefaultDownloadConnections),
    false,
  );
  assert.equal(runtime.handlers.has(desktopChannels.serverSettingsSetStartupDefaults), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadSaveAs), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadStartManaged), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverInstancesList), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverInstancesOpenFolder), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverInstancesDelete), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverConfigurationList), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverConfigurationRead), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverConfigurationWrite), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeGet), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeStart), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeStop), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeSendCommand), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeGetLogs), false);
  assert.equal(runtime.handlers.has(desktopChannels.javaRuntimeScan), false);
  assert.equal(runtime.handlers.has(desktopChannels.javaRuntimeAdd), false);
  assert.equal(runtime.handlers.has(desktopChannels.javaRuntimeRemove), false);
  assert.equal(runtime.handlers.has(desktopChannels.javaRuntimeSetDisabled), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadListTasks), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadCancel), false);
  assert.equal(runtime.handlers.has(desktopChannels.fileDownloadListTasks), false);
  assert.equal(runtime.handlers.has(desktopChannels.fileDownloadCancel), false);
  assert.equal(runtime.handlers.has(desktopChannels.clientBootstrap), false);
  assert.equal(runtime.handlers.has(desktopChannels.rendererReady), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowMinimize), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowToggleMaximize), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowClose), false);
  assert.equal(runtime.handlers.has(desktopChannels.dialogSelectDirectory), false);
  assert.equal(harness.clientEntryListener, undefined);
  assert.equal(harness.serverConsoleListener, undefined);
  assert.equal(runtime.protocolHandlers.has(serverCoreIconScheme), false);
  assert.deepEqual(harness.failures, []);
});

await test("desktop shell keeps macOS alive after the last window closes", async () => {
  const harness = await createDesktopShellHarness("darwin", true);
  harness.runtime.emit("window-all-closed");
  assert.equal(harness.runtime.quitCount, 0);
  await harness.shell.dispose();
});
