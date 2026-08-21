import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerInstanceSnapshot } from "../packages/contracts/src/index.ts";
import {
  listWorldStorage,
  switchWorldStorage,
} from "../components/server/instance-manager/src/world-storage.ts";

const iconPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

await test("world storage lists native and downloaded worlds with level metadata", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-storage-"));
  try {
    await writeFile(
      join(root, "server.properties"),
      "# keep this\nlevel-name=worlds-outer/worlds-inner\n",
    );
    await createWorld(root, "world", "Native World");
    await createWorld(root, "worlds-outer/worlds-inner", "Downloaded World", true);

    const snapshot = await listWorldStorage(instance(root, "fabric"));
    assert.equal(snapshot.mode, "unified");
    assert.equal(snapshot.currentId, "worlds-outer/worlds-inner");
    assert.deepEqual(
      snapshot.saves.map(({ id, name, current }) => ({ id, name, current })),
      [
        { id: "worlds-outer/worlds-inner", name: "Downloaded World", current: true },
        { id: "world", name: "Native World", current: false },
      ],
    );
    assert.match(
      snapshot.saves.find(({ id }) => id === "worlds-outer/worlds-inner")?.iconDataUrl ?? "",
      /^data:image\/png;base64,/u,
    );

    const switched = await switchWorldStorage(instance(root, "fabric"), "world");
    assert.equal(switched.currentId, "world");
    assert.match(await readFile(join(root, "server.properties"), "utf8"), /level-name=world/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("split world storage groups dimensions and switches by world group", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-storage-split-"));
  try {
    await writeFile(join(root, "server.properties"), "level-name=survival\n");
    await createWorld(root, "survival", "Survival");
    await createWorld(root, "survival_nether", "Survival Nether");
    await createWorld(root, "survival_the_end", "Survival End");

    const snapshot = await listWorldStorage(instance(root, "bukkit"));
    assert.equal(snapshot.mode, "split");
    assert.equal(snapshot.dimensions.length, 1);
    assert.equal(snapshot.dimensions[0]?.id, "survival");
    assert.deepEqual(
      snapshot.dimensions[0]?.saves.map(({ dimension }) => dimension),
      ["overworld", "nether", "end"],
    );
    assert.equal(snapshot.dimensions[0]?.current, true);

    const switched = await switchWorldStorage(instance(root, "bukkit"), "survival");
    assert.equal(switched.currentId, "survival");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createWorld(
  root: string,
  relativePath: string,
  levelName: string,
  withIcon = false,
): Promise<void> {
  const directory = join(root, ...relativePath.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "level.dat"), gzipSync(createLevelDat(levelName)));
  if (withIcon) await writeFile(join(directory, "icon.png"), iconPng);
}

function createLevelDat(levelName: string): Uint8Array {
  const bytes: number[] = [
    10, 0, 0, 10, 0, 4, 68, 97, 116, 97, 8, 0, 9, 76, 101, 118, 101, 108, 78, 97, 109, 101,
  ];
  bytes.push(
    (levelName.length >> 8) & 0xff,
    levelName.length & 0xff,
    ...new TextEncoder().encode(levelName),
  );
  bytes.push(0, 0);
  return Uint8Array.from(bytes);
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
