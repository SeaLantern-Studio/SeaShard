import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { test } from "node:test";
import type { ServerInstanceSnapshot } from "../packages/contracts/src/index.ts";
import { createWorldBackup } from "../components/server/instance-manager/src/world-backup.ts";

await test("world backup writes a timestamped zip under the instance UUID", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-backup-"));
  try {
    await writeWorld(root, "world", {
      "level.dat": "level-data",
      "region/r.0.0.mca": "region-data",
    });
    const result = await createWorldBackup(instance(root, "fabric"), "world", {
      now: () => "2026-08-21T14:30:05",
    });
    assert.equal(result.fileName, "2026-08-21_14-30-05.zip");
    assert.equal(result.worldDirectoryName, "world");
    const archivePath = join(
      root,
      `backups-${result.instanceId}`,
      result.worldDirectoryName,
      result.fileName,
    );
    const archive = unzipSync(await readFile(archivePath));
    assert.deepEqual(Object.keys(archive).sort(), ["level.dat", "region/r.0.0.mca"]);
    assert.equal(new TextDecoder().decode(archive["level.dat"]), "level-data");

    const duplicate = await createWorldBackup(instance(root, "fabric"), "world", {
      now: () => "2026-08-21T14:30:05",
    });
    assert.equal(duplicate.fileName, "2026-08-21_14-30-05-1.zip");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("split world backup preserves each dimension directory", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-backup-split-"));
  try {
    await writeWorld(root, "world", { "level.dat": "overworld" });
    await writeWorld(root, "world_nether", { "level.dat": "nether" });
    const result = await createWorldBackup(instance(root, "velocity"), "world", {
      now: () => "2026-08-21T14:30:05",
    });
    const archivePath = join(
      root,
      `backups-${result.instanceId}`,
      result.worldDirectoryName,
      result.fileName,
    );
    const archive = unzipSync(await readFile(archivePath));
    assert.equal(new TextDecoder().decode(archive["world/level.dat"]), "overworld");
    assert.equal(new TextDecoder().decode(archive["world_nether/level.dat"]), "nether");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeWorld(
  root: string,
  relativePath: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, relativePath, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

function instance(rootPath: string, serverType: string): ServerInstanceSnapshot {
  return {
    id: `instance-${serverType}`,
    name: serverType,
    rootPath,
    coreJarPath: join(rootPath, "server.jar"),
    storageMode: "managed",
    source: "downloaded",
    modLoader: null,
    serverType,
    gameVersion: "1.21.1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
