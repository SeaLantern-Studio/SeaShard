import {
  desktopChannels,
  type ServerConfigurationWriteRequest,
} from "../packages/contracts/src/index.ts";
import {
  expectFileDownloadTasks,
  expectServerModFilters,
  expectServerModSearchResult,
  expectServerWorldDatapack,
  expectServerWorldStorageSnapshot,
} from "../apps/desktop/src/main/contract-validation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import {
  createDesktopShellHarness,
  defaultServerStartupSettings,
  initialServerConfigurationDocument,
  serverConfigurationCatalog,
  serverInstances,
  serverInstanceStartupSettings,
  serverInstanceContentCounts,
  serverModFilters,
  serverModSearchResult,
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
  assert.deepEqual(
    await runtime.invoke(desktopChannels.fileDownloadListTasks, 1),
    harness.fileDownloadTasks,
  );
  assert.equal(await runtime.invoke(desktopChannels.fileDownloadCancel, 1, "mod-task-1"), true);
  assert.equal(harness.fileDownloadTasks[0]?.state, "cancelled");
  assert.equal(await runtime.invoke(desktopChannels.fileDownloadCancel, 1, "missing-task"), false);
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
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverInstancesContentCounts, 1, serverInstances[0]!.id),
    serverInstanceContentCounts,
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverInstancesSetStartupSettings,
      1,
      "instance-paper",
      serverInstanceStartupSettings,
    ),
    {
      ...serverInstances[0],
      startupSettings: serverInstanceStartupSettings,
      updatedAt: "2026-08-17T12:00:02.000Z",
    },
  );
  assert.deepEqual(harness.serverInstanceStartupWrites, [
    { instanceId: "instance-paper", settings: serverInstanceStartupSettings },
  ]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverInstancesSetStartupSettings, 1, "instance-paper", {
      ...serverInstanceStartupSettings,
      maximumMemoryMiB: 512,
    }),
    /memory range is invalid/,
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverRuntimePreview,
      1,
      "instance-paper",
      serverInstanceStartupSettings,
    ),
    {
      instanceId: "instance-paper",
      command:
        '"C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe" -XX:+UseG1GC -Xms1536M -Xmx4096M -jar server.jar nogui',
    },
  );
  assert.deepEqual(harness.runtimePreviewRequests, [
    {
      instanceId: "instance-paper",
      startupSettings: serverInstanceStartupSettings,
    },
  ]);
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

await test("desktop shell projects only user-visible file downloads", () => {
  const commonTask = {
    id: "mod-task-1",
    url: "https://cdn.modrinth.com/data/project/version/mod.jar",
    destinationPath: "C:/SeaShard/resources/mod.jar",
    state: "completed",
    downloadedBytes: 1_024,
    totalBytes: 1_024,
    connections: 8,
    progress: 100,
    createdAt: "2026-08-17T12:00:00.000Z",
    finishedAt: "2026-08-17T12:00:01.000Z",
  } as const;
  assert.deepEqual(
    expectFileDownloadTasks([
      {
        ...commonTask,
        metadata: { kind: "server-mod", userVisible: true },
      },
      {
        ...commonTask,
        id: "icon-task-1",
        metadata: { kind: "server-core-icon" },
      },
    ]),
    [
      {
        id: commonTask.id,
        destinationPath: commonTask.destinationPath,
        state: commonTask.state,
        downloadedBytes: commonTask.downloadedBytes,
        totalBytes: commonTask.totalBytes,
        connections: commonTask.connections,
        progress: commonTask.progress,
        createdAt: commonTask.createdAt,
        finishedAt: commonTask.finishedAt,
      },
    ],
  );
});

await test("desktop shell accepts Modrinth optional-server modpack environments", () => {
  const result = expectServerModSearchResult({
    ...serverModSearchResult,
    items: [
      {
        ...serverModSearchResult.items[0],
        resourceType: "modpack",
        environment: ["client_only_server_optional"],
      },
    ],
  });

  assert.deepEqual(result.items[0]?.environment, ["client_only_server_optional"]);
});

await test("desktop shell validates unavailable source results", () => {
  const unavailableReason = "CurseForge 暂时不可用，请稍后重试";
  assert.deepEqual(expectServerModFilters({ ...serverModFilters, unavailableReason }), {
    ...serverModFilters,
    unavailableReason,
  });
  assert.deepEqual(
    expectServerModSearchResult({
      ...serverModSearchResult,
      items: [],
      limit: 0,
      total: 0,
      unavailableReason,
    }),
    {
      items: [],
      offset: serverModSearchResult.offset,
      limit: 0,
      total: 0,
      unavailableReason,
    },
  );
});

await test("desktop shell preserves unknown resource origins in world projections", () => {
  const resourceSource = {
    source: "github",
    id: "owner-repo",
    iconUrl: "https://github.com/owner/repo/icon.png",
  };
  const storage = expectServerWorldStorageSnapshot({
    instanceId: "instance-paper",
    mode: "unified",
    saves: [
      {
        id: "world",
        groupId: "world",
        name: "World",
        dimension: "overworld",
        current: false,
        resourceSource,
      },
    ],
    dimensions: [],
  });
  assert.deepEqual(storage.saves[0]?.resourceSource, resourceSource);
  const datapack = expectServerWorldDatapack({
    instanceId: "instance-paper",
    worldId: "world",
    fileName: "pack.zip",
    kind: "archive",
    updatedAt: "2026-08-21T00:00:00.000Z",
    resourceSource,
  });
  assert.deepEqual(datapack.resourceSource, resourceSource);
});
