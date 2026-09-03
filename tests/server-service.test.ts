import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ServerControllerLogger, redactDiagnostic } from "../apps/server/src/logger.ts";
import { ServerControllerProcessLease } from "../apps/server/src/runtime-control.ts";
import {
  createSystemdUserUnit,
  createWindowsLauncher,
  createWindowsTaskXml,
  readServiceMetadata,
  ServerControllerServiceManager,
} from "../apps/server/src/service-manager.ts";

await test("systemd user unit runs the Controller with failure restart", () => {
  const unit = createSystemdUserUnit({
    executable: "/opt/Sea Shard/node",
    arguments: ["/opt/Sea Shard/server.js", "run", "--data-root=/home/sea/%data"],
    workingDirectory: "/opt/Sea Shard",
  });
  assert.match(unit, /^\[Service\]$/mu);
  assert.match(unit, /ExecStart="\/opt\/Sea Shard\/node"/u);
  assert.match(unit, /--data-root=\/home\/sea\/%%data/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /RestartSec=5s/u);
  assert.match(unit, /WantedBy=default.target/u);
});

await test("Windows current-user task logs on with least privilege and restart", () => {
  const launch = {
    executable: "C:\\Program Files\\nodejs\\node.exe",
    arguments: ["C:\\SeaShard\\server.js", "supervise", "--data-root=C:\\Users\\sea\\Data"],
    workingDirectory: "C:\\SeaShard",
  } as const;
  const launcher = createWindowsLauncher(launch);
  assert.match(launcher, /"C:\\Program Files\\nodejs\\node\.exe"/u);
  assert.match(launcher, /"supervise"/u);

  const task = createWindowsTaskXml({
    launcherPath: "C:\\Users\\sea & reef\\launch.cmd",
    workingDirectory: launch.workingDirectory,
    userId: "REEF\\sea",
    commandInterpreter: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.match(task, /<LogonTrigger>/u);
  assert.match(task, /<UserId>REEF\\sea<\/UserId>/u);
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(task, /<RestartOnFailure>/u);
  assert.match(task, /sea &amp; reef/u);
});

await test("Windows service uninstall removes registration files and preserves user data", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-service-"));
  const persistentData = join(dataRoot, "administrator.json");
  const calls: Array<{ executable: string; arguments: readonly string[] }> = [];
  await writeFile(persistentData, '{"credential":"preserved"}\n', "utf8");
  const manager = new ServerControllerServiceManager({
    dataRoot,
    platform: "win32",
    environment: { ComSpec: "cmd.exe", USERDOMAIN: "REEF" },
    homeDirectory: dataRoot,
    username: "sea",
    launch: {
      executable: "C:\\SeaShard\\seashard-server.exe",
      arguments: ["supervise", `--data-root=${dataRoot}`],
      workingDirectory: "C:\\SeaShard",
    },
    runCommand: async (executable, arguments_) => {
      calls.push({ executable, arguments: arguments_ });
      return {
        code: 0,
        stdout: executable === "whoami.exe" ? '"REEF\\sea","S-1-5-21-1000"\n' : "",
        stderr: "",
      };
    },
  });
  try {
    await manager.install();
    const metadata = await readServiceMetadata(dataRoot);
    assert.equal((metadata as { platform: string }).platform, "win32");
    assert.deepEqual(
      calls.map(({ arguments: arguments_ }) => arguments_[0]),
      ["/user", "/Create", "/Run"],
    );

    await manager.uninstall();
    assert.equal(await readFile(persistentData, "utf8"), '{"credential":"preserved"}\n');
    await assert.rejects(stat(join(dataRoot, "service")), /ENOENT/u);
    assert.deepEqual(
      calls.slice(3).map(({ arguments: arguments_ }) => arguments_[0]),
      ["/End", "/Delete"],
    );
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(dataRoot, { recursive: true, force: true }),
    );
  }
});

await test("process lease rejects duplicate users and removes only its runtime files", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-lease-"));
  const lease = await ServerControllerProcessLease.acquire(dataRoot);
  try {
    await assert.rejects(ServerControllerProcessLease.acquire(dataRoot), /已有 Server Controller/u);
    await lease.publish("http://127.0.0.1:18127");
    const runtime = JSON.parse(
      await readFile(join(dataRoot, "server-controller.runtime.json"), "utf8"),
    ) as { token: string };
    assert.equal(runtime.token, lease.token);
  } finally {
    await lease.release();
    await assert.rejects(stat(join(dataRoot, "server-controller.lock")), /ENOENT/u);
    await assert.rejects(stat(join(dataRoot, "server-controller.runtime.json")), /ENOENT/u);
    await import("node:fs/promises").then(({ rm }) =>
      rm(dataRoot, { recursive: true, force: true }),
    );
  }
});

await test("logger rotates oversized files and redacts credentials before persistence", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-log-"));
  const logFile = join(dataRoot, "server-controller.log");
  await writeFile(logFile, Buffer.alloc(5 * 1024 * 1024, 0x78));
  const logger = await ServerControllerLogger.open(logFile);
  try {
    await logger.info(
      'Authorization: Bearer live-token password="hunter2" api_key=secret-value?token=query-secret',
    );
  } finally {
    await logger.close();
  }
  try {
    assert.equal((await stat(`${logFile}.1`)).size, 5 * 1024 * 1024);
    const current = await readFile(logFile, "utf8");
    assert.equal(current.includes("live-token"), false);
    assert.equal(current.includes("hunter2"), false);
    assert.equal(current.includes("secret-value"), false);
    assert.equal(current.includes("query-secret"), false);
    assert.match(current, /\[REDACTED\]/u);
    assert.equal(redactDiagnostic("token=abc"), "token=[REDACTED]");
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(dataRoot, { recursive: true, force: true }),
    );
  }
});
