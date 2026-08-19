import type { ServerInstanceSnapshot } from "../packages/contracts/src/index.ts";
import {
  ServerConfigurationManager,
  type ServerConfigurationDirectoryEntry,
  type ServerConfigurationFileStat,
  type ServerConfigurationFileSystem,
} from "../components/server/configuration/src/manager.ts";
import assert from "node:assert/strict";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";

class MemoryConfigurationFileSystem implements ServerConfigurationFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  readonly mtimes = new Map<string, Date>();

  constructor(readonly rootPath: string) {
    this.addDirectory(rootPath);
  }

  addDirectory(path: string): void {
    let current = resolve(path);
    for (;;) {
      this.directories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  addTextFile(path: string, content: string, bom = false): void {
    const encoded = new TextEncoder().encode(content);
    const bytes = bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded]) : encoded;
    this.addBytesFile(path, bytes);
  }

  addBytesFile(path: string, content: Uint8Array): void {
    const normalized = resolve(path);
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, Uint8Array.from(content));
    this.mtimes.set(normalized, new Date("2026-08-17T12:00:00.000Z"));
  }

  async readdir(path: string): Promise<readonly ServerConfigurationDirectoryEntry[]> {
    const normalized = this.expectDirectory(path);
    const names = new Map<string, "file" | "directory">();
    for (const directory of this.directories) {
      const relation = relative(normalized, directory);
      if (relation && !relation.includes(sep) && relation !== "..")
        names.set(relation, "directory");
    }
    for (const file of this.files.keys()) {
      const relation = relative(normalized, file);
      if (relation && !relation.includes(sep) && relation !== "..") names.set(relation, "file");
    }
    return [...names.entries()].map(([name, kind]) => ({
      name,
      isFile: () => kind === "file",
      isDirectory: () => kind === "directory",
      isSymbolicLink: () => false,
    }));
  }

  async stat(path: string): Promise<ServerConfigurationFileStat> {
    const normalized = resolve(path);
    const bytes = this.files.get(normalized);
    if (bytes) {
      return this.fileStat(bytes.byteLength, this.mtimes.get(normalized)!);
    }
    if (this.directories.has(normalized)) {
      return {
        size: 0,
        mtime: new Date("2026-08-17T12:00:00.000Z"),
        isFile: () => false,
        isDirectory: () => true,
      };
    }
    throw missingPath(normalized);
  }

  async realpath(path: string): Promise<string> {
    const normalized = resolve(path);
    if (!this.files.has(normalized) && !this.directories.has(normalized))
      throw missingPath(normalized);
    return normalized;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = resolve(path);
    const bytes = this.files.get(normalized);
    if (!bytes) throw missingPath(normalized);
    return Uint8Array.from(bytes);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const normalized = resolve(path);
    if (!this.files.has(normalized)) throw missingPath(normalized);
    this.files.set(normalized, Uint8Array.from(content));
    this.mtimes.set(normalized, new Date("2026-08-17T13:00:01.000Z"));
  }

  async mkdir(path: string): Promise<void> {
    this.addDirectory(path);
  }

  async copyFile(source: string, destination: string): Promise<void> {
    const bytes = this.files.get(resolve(source));
    if (!bytes) throw missingPath(source);
    this.addBytesFile(destination, bytes);
  }

  private expectDirectory(path: string): string {
    const normalized = resolve(path);
    if (!this.directories.has(normalized)) throw missingPath(normalized);
    return normalized;
  }

  private fileStat(size: number, mtime: Date): ServerConfigurationFileStat {
    return { size, mtime, isFile: () => true, isDirectory: () => false };
  }
}

const rootPath = resolve("test-fixtures/server-configuration/instance-paper");
const instance = {
  id: "instance-paper",
  name: "1.21.1-paper",
  rootPath,
  coreJarPath: resolve(rootPath, "server.jar"),
  storageMode: "managed",
  source: "downloaded",
  serverType: "paper",
  gameVersion: "1.21.1",
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:00.000Z",
} satisfies ServerInstanceSnapshot;

function createFixture(): {
  manager: ServerConfigurationManager;
  fileSystem: MemoryConfigurationFileSystem;
} {
  const fileSystem = new MemoryConfigurationFileSystem(rootPath);
  fileSystem.addTextFile(
    resolve(rootPath, "server.properties"),
    "# generated\r\nmotd=SeaShard\r\n",
    true,
  );
  fileSystem.addTextFile(
    resolve(rootPath, "config/paper-global.yml"),
    "timings:\n  enabled: false\n",
  );
  fileSystem.addTextFile(resolve(rootPath, "plugins/Essentials/config.yml"), "locale: zh_CN\n");
  fileSystem.addTextFile(
    resolve(rootPath, "plugins/Essentials/messages.properties"),
    "hello=world\n",
  );
  fileSystem.addTextFile(resolve(rootPath, "plugins/Essentials/readme.md"), "ignored\n");
  fileSystem.addTextFile(resolve(rootPath, "plugins/direct.properties"), "enabled=true\n");
  fileSystem.addBytesFile(resolve(rootPath, "plugins/Broken/config.yml"), Uint8Array.from([0xff]));
  fileSystem.addTextFile(resolve(rootPath, "plugins/plugin.jar"), "ignored\n");
  return {
    fileSystem,
    manager: new ServerConfigurationManager({
      listInstances: async () => [instance],
      fileSystem,
      now: () => new Date("2026-08-17T13:00:00.000Z"),
    }),
  };
}

await test("configuration manager lists allowlisted server files and recursive plugin text configs", async () => {
  const { manager } = createFixture();
  const catalog = await manager.list(instance.id);

  assert.equal(catalog.pluginSupported, true);
  assert.deepEqual(
    catalog.serverFiles.map((file) => file.path),
    ["server.properties", "config/paper-global.yml"],
  );
  assert.deepEqual(
    catalog.plugins.map((plugin) => ({
      name: plugin.name,
      paths: plugin.files.map((file) => file.path),
    })),
    [
      { name: "Broken", paths: ["plugins/Broken/config.yml"] },
      {
        name: "Essentials",
        paths: ["plugins/Essentials/config.yml", "plugins/Essentials/messages.properties"],
      },
      { name: "通用配置", paths: ["plugins/direct.properties"] },
    ],
  );
});

await test("configuration writes preserve UTF-8 BOM, create a backup, and reject a stale revision", async () => {
  const { manager, fileSystem } = createFixture();
  const original = await manager.read(instance.id, "server.properties");
  assert.equal(original.encoding, "utf-8-bom");
  assert.equal(original.content, "# generated\r\nmotd=SeaShard\r\n");

  const saved = await manager.write({
    instanceId: instance.id,
    path: "server.properties",
    content: "# generated\r\nmotd=Updated\r\n",
    expectedRevision: original.revision,
  });
  assert.equal(saved.encoding, "utf-8-bom");
  assert.equal(saved.content, "# generated\r\nmotd=Updated\r\n");
  assert.notEqual(saved.revision, original.revision);
  const backups = [...fileSystem.files.entries()].filter(([path]) =>
    path.includes(`${sep}.seashard${sep}backups${sep}configuration${sep}`),
  );
  assert.equal(backups.length, 1);
  assert.deepEqual(Array.from(backups[0]![1].slice(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.equal(
    new TextDecoder().decode(backups[0]![1].slice(3)),
    "# generated\r\nmotd=SeaShard\r\n",
  );

  await assert.rejects(
    manager.write({
      instanceId: instance.id,
      path: "server.properties",
      content: "motd=Overwrite\n",
      expectedRevision: original.revision,
    }),
    /已被服务器或其他编辑器修改/,
  );
  assert.equal((await manager.read(instance.id, "server.properties")).content, saved.content);
});

await test("configuration manager rejects forged paths, unlisted files, invalid UTF-8, and unknown instances", async () => {
  const { manager } = createFixture();
  await assert.rejects(manager.read(instance.id, "../outside.yml"), /规范的实例内相对路径/);
  await assert.rejects(manager.read(instance.id, "plugins/plugin.jar"), /不在当前实例的可编辑目录/);
  await assert.rejects(manager.read(instance.id, "plugins/Broken/config.yml"), /不是有效的 UTF-8/);
  await assert.rejects(manager.list("missing-instance"), /找不到服务器实例/);
});

function missingPath(path: string): Error {
  return Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
}
