import {
  desktopChannels,
  serverCoreIconScheme,
  serverInstanceIconHost,
} from "../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopShellHarness,
  manuallyAddedJavaInstallation,
  paperIconHash,
  paperIconPath,
  paperInstanceIconPath,
  serverCoreTypes,
  updatedServerStartupSettings,
  javaInstallations,
} from "./desktop-shell-fixtures.ts";

await test("desktop shell rejects IPC from unowned renderers", async () => {
  const harness = await createDesktopShellHarness();
  const { runtime, shell, saveAsRequest } = harness;
  assert.equal(runtime.protocolHandlers.has(serverCoreIconScheme), true);
  assert.equal(
    await runtime.resolveProtocol(serverCoreIconScheme, serverCoreTypes[1]!.iconUrl!),
    paperIconPath,
  );
  assert.equal(
    await runtime.resolveProtocol(
      serverCoreIconScheme,
      `${serverCoreIconScheme}://${serverInstanceIconHost}/instance-paper`,
    ),
    paperInstanceIconPath,
  );
  assert.equal(
    await runtime.resolveProtocol(
      serverCoreIconScheme,
      `seashard-cache://other-host/${paperIconHash}`,
    ),
    undefined,
  );

  assert.equal(runtime.handlers.has(desktopChannels.runtimeSnapshot), true);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 1), /request rejected/);
  assert.equal(runtime.handlers.has(desktopChannels.clientBootstrap), true);
  await assert.rejects(runtime.invoke(desktopChannels.clientBootstrap, 1), /request rejected/);
  assert.equal(runtime.handlers.has(desktopChannels.rendererReady), true);
  await assert.rejects(runtime.invoke(desktopChannels.rendererReady, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.windowMinimize, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.windowToggleMaximize, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.windowClose, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.dialogSelectDirectory, 1),
    /request rejected/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverSettingsGet, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverSettingsSetResourceDownloadDirectory,
      1,
      "D:/Servers/resources",
    ),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, 1, 4),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverSettingsSetStartupDefaults,
      1,
      updatedServerStartupSettings,
    ),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadSaveAs, 1, saveAsRequest),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadStartManaged, 1, saveAsRequest),
    /request rejected/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverInstancesList, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverInstancesOpenFolder, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverInstancesDelete, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverConfigurationList, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverConfigurationRead,
      1,
      "instance-paper",
      "server.properties",
    ),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverConfigurationWrite, 1, {
      instanceId: "instance-paper",
      path: "server.properties",
      content: "motd=Rejected\n",
      expectedRevision: "b".repeat(64),
    }),
    /request rejected/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.javaRuntimeScan, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.javaRuntimeAdd, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.javaRuntimeRemove, 1, manuallyAddedJavaInstallation.path),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.javaRuntimeSetDisabled, 1, javaInstallations[0]!.id, true),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadListTasks, 1),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadCancel, 1, "task-1"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.fileDownloadListTasks, 1),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.fileDownloadCancel, 1, "mod-task-1"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeGet, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeStart, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeStop, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeSendCommand, 1, "instance-paper", "list"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeGetLogs, 1, "instance-paper", 0),
    /request rejected/,
  );
  await shell.dispose();
});
