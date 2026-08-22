import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import type { ServerInstanceSnapshot } from "../packages/contracts/src/index.ts";
import {
  deleteWorldDatapack,
  listWorldDatapacks,
  setWorldDatapackDisabled,
} from "../components/server/instance-manager/src/world-datapacks.ts";
import { readWorldDatapackDisabledNames } from "../components/server/instance-manager/src/world-datapack-config.ts";
import {
  listWorldStorage,
  switchWorldStorage,
} from "../components/server/instance-manager/src/world-storage.ts";

const iconPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const animatedGif = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00,
  0x00, 0x3b,
]);

await test("world storage lists native and downloaded worlds with level metadata", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-storage-"));
  try {
    await writeFile(
      join(root, "server.properties"),
      "# keep this\nlevel-name=worlds-outer/worlds-inner\n",
    );
    await createWorld(root, "world", "Native World");
    await createWorld(root, "worlds-outer/worlds-inner", "Downloaded World", true);

    const snapshot = await listWorldStorage({
      ...instance(root, "fabric"),
      resourceSources: {
        worlds: {
          "worlds-outer/worlds-inner": {
            source: "modrinth",
            id: "world-project",
            iconUrl: "https://cdn.modrinth.com/data/world-project/icon.webp",
          },
        },
      },
    });
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
    assert.deepEqual(
      snapshot.saves.find(({ id }) => id === "worlds-outer/worlds-inner")?.resourceSource,
      {
        source: "modrinth",
        id: "world-project",
        iconUrl: "https://cdn.modrinth.com/data/world-project/icon.webp",
      },
    );

    const switched = await switchWorldStorage(instance(root, "fabric"), "world");
    assert.equal(switched.currentId, "world");
    assert.match(await readFile(join(root, "server.properties"), "utf8"), /level-name=world/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("world storage preserves GIF icon bytes and MIME type", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-gif-icons-"));
  try {
    await writeFile(join(root, "server.properties"), "level-name=worlds-gif-in-png\n");
    await createWorld(root, "worlds-gif-in-png", "GIF in PNG");
    await writeFile(join(root, "worlds-gif-in-png", "icon.png"), animatedGif);
    await createWorld(root, "worlds-gif-file", "GIF file");
    await writeFile(join(root, "worlds-gif-file", "icon.gif"), animatedGif);

    const snapshot = await listWorldStorage(instance(root, "fabric"));
    const expectedIconDataUrl = `data:image/gif;base64,${Buffer.from(animatedGif).toString("base64")}`;

    assert.equal(
      snapshot.saves.find(({ id }) => id === "worlds-gif-in-png")?.iconDataUrl,
      expectedIconDataUrl,
    );
    assert.equal(
      snapshot.saves.find(({ id }) => id === "worlds-gif-file")?.iconDataUrl,
      expectedIconDataUrl,
    );
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
await test("world datapacks lists archives and valid folders from the logical overworld", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-world-datapacks-"));
  try {
    await writeFile(join(root, "server.properties"), "level-name=survival\n");
    await createWorld(root, "survival", "Survival");
    await createWorld(root, "survival_nether", "Survival Nether");

    const datapackDirectory = join(root, "survival", "datapacks");
    await mkdir(join(datapackDirectory, "local-pack"), { recursive: true });
    await writeFile(
      join(datapackDirectory, "local-pack", "pack.mcmeta"),
      JSON.stringify({ pack: { pack_format: 48, description: "本地数据包介绍" } }),
      "utf8",
    );
    await writeFile(join(datapackDirectory, "local-pack", "pack.png"), iconPng);
    const remoteArchive = zipSync({
      "pack.mcmeta": strToU8(
        JSON.stringify({ pack: { pack_format: 48, description: "远程数据包介绍" } }),
      ),
      "pack.png": iconPng,
    });
    await writeFile(join(datapackDirectory, "remote.zip"), remoteArchive);
    await mkdir(join(datapackDirectory, "unrelated"), { recursive: true });
    await writeFile(join(datapackDirectory, "unrelated", "readme.txt"), "ignore");

    const netherDatapacks = join(root, "survival_nether", "datapacks");
    await mkdir(netherDatapacks, { recursive: true });
    await writeFile(join(netherDatapacks, "wrong.zip"), Uint8Array.of(4, 5, 6));

    const worldInstance = {
      ...instance(root, "bukkit"),
      resourceSources: {
        datapacks: {
          "survival/datapacks/remote.zip": {
            source: "curseforge",
            id: "123",
            version: "2.0.0",
            iconUrl: "https://media.forgecdn.net/files/123/456/icon.png",
          },
        },
      },
    } satisfies ServerInstanceSnapshot;
    const datapacks = await listWorldDatapacks(worldInstance, "survival");
    assert.deepEqual(
      datapacks
        .map(({ fileName, kind, disabled }) => ({ fileName, kind, disabled }))
        .sort((left, right) => left.fileName.localeCompare(right.fileName)),
      [
        { fileName: "local-pack", kind: "directory", disabled: false },
        { fileName: "remote.zip", kind: "archive", disabled: false },
      ],
    );
    assert.deepEqual([...(await readWorldDatapackDisabledNames(join(root, "survival")))], []);
    assert.equal(
      datapacks.find(({ fileName }) => fileName === "local-pack")?.description,
      "本地数据包介绍",
    );
    assert.equal(
      datapacks.find(({ fileName }) => fileName === "remote.zip")?.description,
      "远程数据包介绍",
    );
    const expectedDatapackIcon = `data:image/png;base64,${Buffer.from(iconPng).toString("base64")}`;
    assert.equal(
      datapacks.find(({ fileName }) => fileName === "local-pack")?.iconDataUrl,
      expectedDatapackIcon,
    );
    assert.equal(
      datapacks.find(({ fileName }) => fileName === "remote.zip")?.iconDataUrl,
      expectedDatapackIcon,
    );
    assert.deepEqual(datapacks.find(({ fileName }) => fileName === "remote.zip")?.resourceSource, {
      source: "curseforge",
      id: "123",
      version: "2.0.0",
      iconUrl: "https://media.forgecdn.net/files/123/456/icon.png",
    });

    const disabledPack = await setWorldDatapackDisabled(
      worldInstance,
      "survival",
      "remote.zip",
      true,
    );
    assert.equal(disabledPack.fileName, "remote.zip");
    assert.equal(disabledPack.disabled, true);
    assert.deepEqual(
      disabledPack.resourceSource,
      datapacks.find(({ fileName }) => fileName === "remote.zip")?.resourceSource,
    );
    assert.deepEqual(
      [...(await readWorldDatapackDisabledNames(join(root, "survival")))],
      ["remote.zip"],
    );
    await assert.rejects(readFile(join(datapackDirectory, "remote.zip.disable")), /ENOENT/u);
    assert.deepEqual(
      (await listWorldDatapacks(worldInstance, "survival"))
        .map(({ fileName, disabled }) => ({ fileName, disabled }))
        .sort((left, right) => left.fileName.localeCompare(right.fileName)),
      [
        { fileName: "local-pack", disabled: false },
        { fileName: "remote.zip", disabled: true },
      ],
    );

    const enabledPack = await setWorldDatapackDisabled(
      worldInstance,
      "survival",
      "remote.zip",
      false,
    );
    assert.equal(enabledPack.fileName, "remote.zip");
    assert.equal(enabledPack.disabled, false);
    assert.deepEqual([...(await readWorldDatapackDisabledNames(join(root, "survival")))], []);
    assert.equal(
      (await listWorldStorage(worldInstance)).dimensions[0]?.saves.find(
        ({ id }) => id === "survival",
      )?.name,
      "Survival",
    );

    const disabledFolder = await setWorldDatapackDisabled(
      worldInstance,
      "survival",
      "local-pack",
      true,
    );
    assert.equal(disabledFolder.fileName, "local-pack");
    assert.equal(disabledFolder.disabled, true);
    const deletedFolder = await deleteWorldDatapack(worldInstance, "survival", "local-pack");
    assert.deepEqual(deletedFolder.relativePaths, ["survival/datapacks/local-pack"]);
    await assert.rejects(readFile(join(datapackDirectory, "local-pack", "pack.mcmeta")), /ENOENT/u);
    const deletedArchive = await deleteWorldDatapack(worldInstance, "survival", "remote.zip");
    assert.deepEqual(deletedArchive.relativePaths, ["survival/datapacks/remote.zip"]);
    await assert.rejects(readFile(join(datapackDirectory, "remote.zip")), /ENOENT/u);
    assert.deepEqual(await listWorldDatapacks(worldInstance, "survival"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Quilt world datapacks use the server working directory for source keys", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-quilt-world-datapacks-"));
  try {
    const serverRoot = join(root, "server");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(
      join(serverRoot, "server.properties"),
      "level-name=worlds-a1b2c3/worlds-d4e5f6\n",
    );
    await createWorld(serverRoot, "worlds-a1b2c3/worlds-d4e5f6", "Quilt World");
    const datapackDirectory = join(serverRoot, "worlds-a1b2c3", "worlds-d4e5f6", "datapacks");
    await mkdir(datapackDirectory, { recursive: true });
    await writeFile(join(datapackDirectory, "remote.zip"), Uint8Array.of(1, 2, 3));

    const datapacks = await listWorldDatapacks(
      {
        ...instance(root, "quilt"),
        resourceSources: {
          datapacks: {
            "worlds-a1b2c3/worlds-d4e5f6/datapacks/remote.zip": {
              source: "modrinth",
              id: "quilt-pack",
            },
          },
        },
      },
      "worlds-a1b2c3/worlds-d4e5f6",
    );
    assert.deepEqual(
      datapacks.map(({ fileName }) => fileName),
      ["remote.zip"],
    );
    assert.deepEqual(datapacks[0]?.resourceSource, {
      source: "modrinth",
      id: "quilt-pack",
    });
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
  const bytes: number[] = [10, 0, 0];
  pushNamedCompound(bytes, "Data");
  pushNamedString(bytes, "LevelName", levelName);
  pushNamedCompound(bytes, "DataPacks");
  pushNamedStringList(bytes, "Enabled", ["vanilla"]);
  pushNamedStringList(bytes, "Disabled", []);
  bytes.push(0, 0, 0);
  return Uint8Array.from(bytes);
}

function pushNamedCompound(bytes: number[], name: string): void {
  bytes.push(10);
  pushNbtString(bytes, name);
}

function pushNamedString(bytes: number[], name: string, value: string): void {
  bytes.push(8);
  pushNbtString(bytes, name);
  pushNbtString(bytes, value);
}

function pushNamedStringList(bytes: number[], name: string, values: readonly string[]): void {
  bytes.push(9);
  pushNbtString(bytes, name);
  bytes.push(8);
  pushNbtInt32(bytes, values.length);
  for (const value of values) pushNbtString(bytes, value);
}

function pushNbtString(bytes: number[], value: string): void {
  const encoded = new TextEncoder().encode(value);
  bytes.push((encoded.byteLength >> 8) & 0xff, encoded.byteLength & 0xff, ...encoded);
}

function pushNbtInt32(bytes: number[], value: number): void {
  bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function instance(rootPath: string, serverType: string): ServerInstanceSnapshot {
  return {
    id: `instance-${serverType}`,
    name: serverType,
    rootPath,
    coreJarPath: join(rootPath, "server.jar"),
    source: "downloaded",
    storageMode: "managed",
    modLoader: null,
    serverType,
    gameVersion: "1.21.1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
