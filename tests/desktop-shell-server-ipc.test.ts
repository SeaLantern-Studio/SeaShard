import {
  desktopChannels,
  type ServerConfigurationWriteRequest,
} from "../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import {
  createDesktopShellHarness,
  defaultServerStartupSettings,
  initialServerConfigurationDocument,
  serverConfigurationCatalog,
  serverInstances,
  updatedServerStartupSettings,
} from "./desktop-shell-fixtures.ts";

await test("desktop shell routes settings, downloads, instances, and configuration IPC", async () => {
  const harness = await createDesktopShellHarness();
  const { runtime, shell, saveAsRequest } = harness;
  await shell.service.openPrimary();
  const first = runtime.windows[0]!;
  assert.equal(
    await runtime.invoke(desktopChannels.dialogSelectDirectory, 1),
    runtime.directorySelection,
  );
  assert.equal(runtime.directorySelectionWindow, first as unknown as BrowserWindow);
  assert.deepEqual(runtime.directorySelectionOptions, {
    title: "选择资源默认下载地址",
    buttonLabel: "选择此文件夹",
    defaultPath: "C:/SeaShard/resources",
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.dialogSelectDirectory, 999),
    /request rejected/,
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverSettingsGet, 1),
    harness.serverSettings,
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverSettingsSetResourceDownloadDirectory,
      1,
      "D:/Servers/resources",
    ),
    {
      resourceDownloadDirectory: "D:/Servers/resources",
      defaultDownloadConnections: 16,
      ...defaultServerStartupSettings,
    },
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, 1, 4),
    {
      resourceDownloadDirectory: "D:/Servers/resources",
      defaultDownloadConnections: 4,
      ...defaultServerStartupSettings,
    },
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverSettingsSetStartupDefaults,
      1,
      updatedServerStartupSettings,
    ),
    {
      resourceDownloadDirectory: "D:/Servers/resources",
      defaultDownloadConnections: 4,
      ...updatedServerStartupSettings,
    },
  );
  assert.deepEqual(harness.serverSettings, {
    resourceDownloadDirectory: "D:/Servers/resources",
    defaultDownloadConnections: 4,
    ...updatedServerStartupSettings,
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, 1, 42),
    /must be a string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, 1, 4.5),
    /must be a safe integer/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetStartupDefaults, 1, {
      ...updatedServerStartupSettings,
      autoAcceptEula: "yes",
    }),
    /must be a boolean/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverSettingsGet, 999), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, 999, "E:/Rejected"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverSettingsSetStartupDefaults,
      999,
      updatedServerStartupSettings,
    ),
    /request rejected/,
  );
  runtime.directorySelection = "D:/Downloads";
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreDownloadSaveAs, 1, saveAsRequest),
    harness.downloadTasks[0],
  );
  assert.deepEqual(runtime.directorySelectionOptions, {
    title: "选择 custom-paper.jar 的保存文件夹",
    buttonLabel: "保存到此文件夹",
    defaultPath: "D:/Servers/resources",
  });
  assert.deepEqual(harness.startedDownloads, [
    {
      ...saveAsRequest,
      destinationDirectory: "D:/Downloads",
      connections: 4,
    },
  ]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreDownloadListTasks, 1),
    harness.downloadTasks,
  );
  assert.equal(await runtime.invoke(desktopChannels.serverCoreDownloadCancel, 1, "task-1"), true);
  assert.equal(harness.downloadTasks[0]?.state, "cancelled");
  runtime.directorySelection = undefined;
  assert.equal(
    await runtime.invoke(desktopChannels.serverCoreDownloadSaveAs, 1, saveAsRequest),
    undefined,
  );
  assert.equal(
    harness.startedDownloads.length,
    1,
    "cancelling the folder dialog must not start a task",
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreDownloadStartManaged, 1, saveAsRequest),
    { instanceId: "instance-managed", task: harness.downloadTasks[1] },
  );
  assert.deepEqual(harness.startedManagedDownloads, [{ ...saveAsRequest, connections: 4 }]);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverInstancesList, 1), serverInstances);
  assert.equal(
    await runtime.invoke(desktopChannels.serverInstancesOpenFolder, 1, "instance-paper"),
    undefined,
  );
  assert.deepEqual(runtime.openedPaths, [serverInstances[0]!.rootPath]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverInstancesOpenFolder, 1, "missing-instance"),
    /找不到服务器实例/,
  );
  assert.equal(
    await runtime.invoke(desktopChannels.serverInstancesDelete, 1, "instance-paper"),
    undefined,
  );
  assert.deepEqual(harness.deletedServerInstances, ["instance-paper"]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverConfigurationList, 1, "instance-paper"),
    serverConfigurationCatalog,
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverConfigurationRead,
      1,
      "instance-paper",
      "server.properties",
    ),
    initialServerConfigurationDocument,
  );
  const configurationWrite = {
    instanceId: "instance-paper",
    path: "server.properties",
    content: "motd=Updated\n",
    expectedRevision: "b".repeat(64),
  } satisfies ServerConfigurationWriteRequest;
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverConfigurationWrite, 1, configurationWrite),
    harness.serverConfigurationDocument,
  );
  assert.deepEqual(harness.configurationWrites, [configurationWrite]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverConfigurationWrite, 1, {
      ...configurationWrite,
      content: 42,
    }),
    /must be a string/,
  );
  await shell.dispose();
});
