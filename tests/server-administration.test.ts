import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServerRuntimeService } from "../packages/contracts/src/index.ts";
import { ServerFileManager } from "../components/server/file-manager/src/index.ts";
import type { ServerInstanceManagerService } from "../components/server/instance-manager/src/index.ts";
import { ServerPlayerManager } from "../components/server/player-manager/src/index.ts";

const instanceId = "server-test";

await test("Host file manager confines text mutations to a stopped registered instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-server-files-"));
  let runtimeState = "stopped";
  const manager = new ServerFileManager(
    instanceService(root),
    runtimeService(() => runtimeState),
  );
  try {
    await mkdir(join(root, "config"));
    const created = await manager.writeText({
      instanceId,
      path: "config/server.yml",
      content: "enabled: true\n",
    });
    assert.equal(created.content, "enabled: true\n");
    assert.deepEqual(
      (await manager.list(instanceId, "config")).map(({ name, kind }) => ({ name, kind })),
      [{ name: "server.yml", kind: "file" }],
    );
    await assert.rejects(
      manager.writeText({
        instanceId,
        path: "config/server.yml",
        content: "enabled: false\n",
        expectedRevision: "0".repeat(64),
      }),
      /其他程序修改/u,
    );
    await assert.rejects(manager.readText(instanceId, "../outside.txt"), /相对路径无效/u);
    await assert.rejects(
      manager.writeText({ instanceId, path: "seashard.json", content: "{}" }),
      /不可编辑/u,
    );

    runtimeState = "running";
    await assert.rejects(
      manager.writeText({
        instanceId,
        path: "config/server.yml",
        content: "enabled: false\n",
      }),
      /必须先停止服务器/u,
    );
    runtimeState = "stopped";
    await manager.delete(instanceId, "config/server.yml");
    assert.deepEqual(await manager.list(instanceId, "config"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Host player manager preserves Minecraft lists and blocks live file rewrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-server-players-"));
  let runtimeState = "stopped";
  const manager = new ServerPlayerManager(
    instanceService(root),
    runtimeService(() => runtimeState),
  );
  const alex = { uuid: "ec561538-f3fd-461d-aff5-086b22154bce", name: "Alex" };
  try {
    await Promise.all([
      writeFile(join(root, "server.properties"), "online-mode=true\nwhite-list=false\n", "utf8"),
      writeFile(join(root, "usercache.json"), `${JSON.stringify([alex])}\n`, "utf8"),
      writeFile(join(root, "whitelist.json"), "[]\n", "utf8"),
      writeFile(join(root, "banned-players.json"), "[]\n", "utf8"),
      writeFile(join(root, "ops.json"), "[]\n", "utf8"),
    ]);

    let catalog = await manager.setWhitelistEnabled(instanceId, true);
    assert.equal(catalog.whitelistEnabled, true);
    catalog = await manager.setWhitelisted(instanceId, alex, true);
    assert.equal(catalog.players[0]?.whitelisted, true);
    catalog = await manager.setBanned(instanceId, { ...alex, reason: "smoke" }, true);
    assert.equal(catalog.players[0]?.banned, true);
    assert.equal(catalog.players[0]?.banReason, "smoke");
    const storedWhitelist = JSON.parse(await readFile(join(root, "whitelist.json"), "utf8"));
    assert.deepEqual(storedWhitelist, [alex]);

    runtimeState = "running";
    await assert.rejects(manager.setWhitelisted(instanceId, alex, false), /必须先停止服务器/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function instanceService(rootPath: string): ServerInstanceManagerService {
  return {
    list: async () => [{ id: instanceId, rootPath }],
  } as unknown as ServerInstanceManagerService;
}

function runtimeService(state: () => string): ServerRuntimeService {
  return {
    get: async () => ({ state: state() }),
  } as unknown as ServerRuntimeService;
}
