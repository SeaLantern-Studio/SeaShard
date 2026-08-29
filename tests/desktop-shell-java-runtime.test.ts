import { desktopChannels } from "../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import {
  createDesktopShellHarness,
  javaInstallations,
  manuallyAddedJavaInstallation,
  serverConsoleLine,
  stoppedServerRuntime,
} from "./desktop-shell-fixtures.ts";

await test("desktop shell routes Java and server runtime IPC", async () => {
  const harness = await createDesktopShellHarness();
  const { runtime, shell } = harness;
  await shell.service.openPrimary();
  const first = runtime.windows[0]!;
  assert.deepEqual(await runtime.invoke(desktopChannels.javaRuntimeScan, 1), javaInstallations);
  await assert.rejects(runtime.invoke(desktopChannels.javaRuntimeScan, 999), /request rejected/);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.javaRuntimeAdd, 1),
    manuallyAddedJavaInstallation,
  );
  assert.equal(runtime.fileSelectionWindow, first as unknown as BrowserWindow);
  assert.deepEqual(runtime.fileSelectionOptions, {
    title: "选择 Java 可执行文件",
    buttonLabel: "添加此 Java",
    filters: [{ name: "Java 可执行文件", extensions: ["exe"] }],
  });
  assert.deepEqual(harness.inspectedJavaPaths, ["D:/Java/bin/java.exe"]);
  assert.equal(
    await runtime.invoke(desktopChannels.javaRuntimeRemove, 1, manuallyAddedJavaInstallation.path),
    true,
  );
  assert.deepEqual(harness.removedJavaPaths, [manuallyAddedJavaInstallation.path]);
  await assert.rejects(
    runtime.invoke(desktopChannels.javaRuntimeRemove, 1, ""),
    /non-empty string/,
  );
  assert.equal(
    await runtime.invoke(desktopChannels.javaRuntimeSetDisabled, 1, javaInstallations[0]!.id, true),
    true,
  );
  assert.deepEqual(harness.javaDisabledUpdates, [
    { installationId: javaInstallations[0]!.id, disabled: true },
  ]);
  await assert.rejects(
    runtime.invoke(desktopChannels.javaRuntimeSetDisabled, 1, javaInstallations[0]!.id, "true"),
    /must be a boolean/,
  );
  runtime.fileSelection = undefined;
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverRuntimeGet, 1, "instance-paper"),
    stoppedServerRuntime,
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.serverRuntimeStart, 1, "instance-paper"), {
    instanceId: "instance-paper",
    state: "running",
    pid: 4_242,
    startedAt: "2026-08-17T12:00:02.000Z",
  });
  assert.equal(
    await runtime.invoke(desktopChannels.serverRuntimeSendCommand, 1, "instance-paper", "list"),
    undefined,
  );
  assert.deepEqual(harness.serverCommands, ["list"]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverRuntimeGetLogs, 1, "instance-paper", 0),
    [serverConsoleLine],
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverRuntimeGetLogs,
      1,
      "instance-paper",
      serverConsoleLine.sequence,
    ),
    [],
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.serverRuntimeStop, 1, "instance-paper"), {
    instanceId: "instance-paper",
    state: "stopped",
    stoppedAt: "2026-08-17T12:00:03.000Z",
    exitCode: 0,
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeSendCommand, 1, "instance-paper", ""),
    /non-empty string/,
  );
  assert.equal(await runtime.invoke(desktopChannels.javaRuntimeAdd, 1), undefined);
  assert.deepEqual(
    harness.inspectedJavaPaths,
    ["D:/Java/bin/java.exe"],
    "取消文件选择不能调用 Java 检查服务",
  );
  await shell.dispose();
});
