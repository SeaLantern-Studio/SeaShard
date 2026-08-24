import {
  agentModelConfigurationChangedEvent,
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
  serverInstanceStartupSettings,
  serverInstanceContentCounts,
  updatedServerStartupSettings,
} from "./desktop-shell-fixtures.ts";

await test("desktop shell routes settings, downloads, instances, and configuration IPC", async () => {
  const harness = await createDesktopShellHarness();
  const { runtime, shell, saveAsRequest } = harness;
  await shell.service.openPrimary();
  const first = runtime.windows[0]!;
  assert.deepEqual(await runtime.invoke(desktopChannels.agentModelsList, 1), []);
  assert.deepEqual(await runtime.invoke(desktopChannels.agentSessionsList, 1), []);
  assert.equal(
    (
      (await runtime.invoke(desktopChannels.agentSessionGet, 1, "agent-session")) as {
        title: string;
      }
    ).title,
    "新对话",
  );
  assert.equal(
    (
      (await runtime.invoke(desktopChannels.agentSessionCopy, 1, "agent-session")) as {
        id: string;
      }
    ).id,
    "agent-session-copy",
  );
  await runtime.invoke(desktopChannels.agentSessionDelete, 1, "agent-session");
  assert.deepEqual(
    await runtime.invoke(desktopChannels.agentSessionStart, 1, {
      initialMessage: { text: "hello" },
      mode: "agent",
      model: { connectionId: "test", modelId: "test-model" },
    }),
    { sessionId: "agent-session", invocationId: "agent-invocation" },
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.agentMessageSend, 1, {
      sessionId: "agent-session",
      message: { text: "continue" },
      mode: "chat",
      model: { connectionId: "test", modelId: "test-model" },
    }),
    { sessionId: "agent-session", invocationId: "agent-invocation" },
  );
  assert.equal(
    (
      (await runtime.invoke(desktopChannels.agentInvocationGet, 1, "agent-invocation")) as {
        text: string;
      }
    ).text,
    "done",
  );
  await runtime.invoke(desktopChannels.agentInvocationCancel, 1, "agent-invocation");
  assert.equal(
    (
      (await runtime.invoke(desktopChannels.agentModelConfigurationGet, 1)) as {
        revision: string;
      }
    ).revision,
    "a".repeat(64),
  );
  const eventSnapshot = {
    revision: "a".repeat(64),
    connections: [],
    models: [],
    providerTypes: [],
    diagnostics: [],
  };
  await shell.emitEvent(agentModelConfigurationChangedEvent, eventSnapshot);
  assert.deepEqual(first.sent.at(-1), {
    channel: desktopChannels.agentModelConfigurationChanged,
    payload: eventSnapshot,
  });
  assert.deepEqual(
    await runtime.invoke(desktopChannels.agentModelDiscover, 1, {
      providerType: "openai-compatible",
      settings: { baseURL: "http://127.0.0.1:8000/v1" },
      credentialValue: "temporary-secret",
    }),
    [{ id: "discovered-model" }],
  );
  assert.equal(
    (
      (await runtime.invoke(desktopChannels.agentModelConfigurationReset, 1, {
        expectedRevision: "a".repeat(64),
      })) as { revision: string }
    ).revision,
    "b".repeat(64),
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.agentModelConnectionMutate, 1, {
      expectedRevision: "b".repeat(64),
      connectionId: "",
      operations: [],
    }),
    /connection ID must be a non-empty string/u,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.agentCredentialWrite, 1, {
      credentialId: "agent.connection.test",
      value: "",
    }),
    /credential value must be a non-empty string/u,
  );
  await runtime.invoke(desktopChannels.agentModelConfigurationOpen, 1);
  await assert.rejects(
    runtime.invoke(desktopChannels.agentSessionStart, 1, { initialMessage: { text: "" } }),
    /non-empty string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.agentSessionStart, 1, {
      initialMessage: { text: "hello" },
      mode: "invalid",
    }),
    /mode must be chat or agent/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.agentModelsList, 999), /request rejected/);
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
    await runtime.invoke(desktopChannels.serverInstancesMods, 1, "instance-paper"),
    [],
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverInstancesSetModDisabled,
      1,
      "instance-paper",
      "mods/example.jar",
      true,
    ),
    {
      instanceId: "instance-paper",
      relativePath: "mods/example.jar",
      fileName: "example.jar",
      name: "Fixture Mod",
      addedAt: "2026-08-17T12:00:00.000Z",
      disabled: true,
    },
  );
  assert.equal(
    await runtime.invoke(
      desktopChannels.serverInstancesDeleteMod,
      1,
      "instance-paper",
      "mods/example.jar",
    ),
    undefined,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverInstancesSetModDisabled,
      1,
      "instance-paper",
      "mods/example.jar",
      "true",
    ),
    /must be a boolean/u,
  );
  await runtime.invoke(desktopChannels.serverRuntimeStart, 1, "instance-paper");
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverInstancesSetModDisabled,
      1,
      "instance-paper",
      "mods/example.jar",
      true,
    ),
    /关停服务器之后才能操作 MOD/u,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverInstancesDeleteMod,
      1,
      "instance-paper",
      "mods/example.jar",
    ),
    /关停服务器之后才能操作 MOD/u,
  );
  await runtime.invoke(desktopChannels.serverRuntimeStop, 1, "instance-paper");
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverInstancesSetWorldDatapackDisabled,
      1,
      "instance-paper",
      "world",
      "pack.zip",
      true,
    ),
    {
      instanceId: "instance-paper",
      worldId: "world",
      fileName: "pack.zip",
      kind: "archive",
      disabled: true,
      updatedAt: "2026-08-17T12:00:02.000Z",
    },
  );
  assert.equal(
    await runtime.invoke(
      desktopChannels.serverInstancesDeleteWorldDatapack,
      1,
      "instance-paper",
      "world",
      "pack.zip",
    ),
    undefined,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverInstancesSetWorldDatapackDisabled,
      1,
      "instance-paper",
      "world",
      "pack.zip",
      "true",
    ),
    /must be a boolean/u,
  );
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
