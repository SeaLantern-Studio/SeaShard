import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import test from "node:test";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import { DownloadManager, type DownloadService } from "../components/network/download/src/index.ts";
import {
  CnbServerCoreCatalog,
  ServerCoreSourceCoordinator,
  SQLiteCnbCatalogCache,
  parseCnbCatalog,
  serverCoreSourceCatalogDataCapsule,
  type CnbCatalogCache,
  type CnbCatalogCacheRecord,
  type ServerCoreDownloadTaskSnapshot,
} from "../components/server/core-source/src/index.ts";

const catalogUrl = "https://cnb.cool/test/catalog.json";
const fileName = "paper-1.21.1.jar";
const artifactBytes = Buffer.from("SeaShard server core fixture\n", "utf8");
const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
const artifactUrl = `https://cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/lfs/${artifactHash}?name=${fileName}`;
const databaseWorkerEntry = new URL("../apps/database-worker/dist/index.js", import.meta.url);

function catalogFixture(url = artifactUrl): object {
  return {
    types: ["paper"],
    paper: {
      versions: ["1.21.1"],
      "1.21.1": { [fileName]: url },
    },
  };
}

function fixtureFetch(body = artifactBytes): typeof globalThis.fetch {
  return async (input) => {
    const url = requestUrl(input);
    if (url === catalogUrl) {
      return Response.json(catalogFixture(), { status: 200 });
    }
    if (url === artifactUrl) {
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    }
    return new Response("missing", { status: 404 });
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

class MemoryCnbCatalogCache implements CnbCatalogCache {
  private record?: CnbCatalogCacheRecord;

  async load(): Promise<CnbCatalogCacheRecord | undefined> {
    return this.record ? { ...this.record } : undefined;
  }

  async store(_catalogUrl: string, record: CnbCatalogCacheRecord): Promise<void> {
    this.record = { ...record };
  }

  async touch(_catalogUrl: string, fetchedAt: string): Promise<void> {
    if (!this.record) throw new Error("cannot touch an empty catalog cache");
    this.record = { ...this.record, fetchedAt };
  }
}

function createCatalog(
  fetchImplementation: typeof globalThis.fetch,
  cache: CnbCatalogCache = new MemoryCnbCatalogCache(),
): Promise<CnbServerCoreCatalog> {
  return CnbServerCoreCatalog.create({
    cache,
    catalogUrl,
    fetchProvider: () => fetchImplementation,
  });
}

/** 测试直接持有执行器时，用薄适配器模拟跨组件的异步 Service 边界。 */
function exposeDownloads(manager: DownloadManager): DownloadService {
  return {
    start: (request) => manager.start(request),
    snapshot: async (taskId) => manager.snapshot(taskId) ?? null,
    listTasks: async () => manager.listTasks(),
    cancel: (taskId) => manager.cancel(taskId),
  };
}

async function waitForFinished(
  coordinator: ServerCoreSourceCoordinator,
  taskId: string,
): Promise<ServerCoreDownloadTaskSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await coordinator.snapshot(taskId);
    if (!snapshot) throw new Error("download task disappeared");
    if (["completed", "failed", "cancelled"].includes(snapshot.state)) return snapshot;
    await yieldToEventLoop();
  }
  throw new Error("download task did not finish");
}

async function waitForDownloaded(
  coordinator: ServerCoreSourceCoordinator,
  taskId: string,
): Promise<ServerCoreDownloadTaskSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await coordinator.snapshot(taskId);
    if (!snapshot) throw new Error("download task disappeared");
    if (snapshot.downloadedBytes > 0) return snapshot;
    if (["completed", "failed", "cancelled"].includes(snapshot.state)) {
      throw new Error(`download task finished before streaming: ${snapshot.state}`);
    }
    await yieldToEventLoop();
  }
  throw new Error("download task did not start streaming");
}

await test("CNB catalog exposes validated types, versions, and SHA-256 artifacts", async () => {
  let requests = 0;
  const fetchImplementation: typeof globalThis.fetch = async (input) => {
    requests += 1;
    assert.equal(requestUrl(input), catalogUrl);
    return Response.json(catalogFixture());
  };
  const catalog = await createCatalog(fetchImplementation);

  assert.deepEqual(await catalog.listTypes(), ["paper"]);
  assert.deepEqual(await catalog.listVersions("paper"), ["1.21.1"]);
  assert.deepEqual(await catalog.listArtifacts("paper", "1.21.1"), [
    {
      source: "cnb",
      serverType: "paper",
      gameVersion: "1.21.1",
      fileName,
      url: artifactUrl,
      sha256: artifactHash,
    },
  ]);
  assert.equal(requests, 1, "immutable release catalog should be cached");
});

await test("CNB catalog persists in SQLite and refreshes conditionally on startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-cnb-cache-"));
  const databasePath = join(directory, "seashard.sqlite3");
  let broker = await SQLiteDatabaseBroker.create({
    databasePath,
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });

  try {
    let repository = await broker.registerCapsule(serverCoreSourceCatalogDataCapsule);
    let cache = new SQLiteCnbCatalogCache(repository);
    const first = await createCatalog(async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("if-none-match"), null);
      return Response.json(catalogFixture(), {
        headers: { etag: '"catalog-v1"', "last-modified": "Sun, 16 Aug 2026 00:00:00 GMT" },
      });
    }, cache);
    assert.deepEqual(await first.listTypes(), ["paper"]);

    // 关闭并重开 Broker，证明下一次启动读取的是用户目录中的 SQLite，而不是进程内存。
    await broker.close();
    broker = await SQLiteDatabaseBroker.create({
      databasePath,
      workerEntry: databaseWorkerEntry,
      readWorkers: 1,
    });
    repository = await broker.registerCapsule(serverCoreSourceCatalogDataCapsule);
    cache = new SQLiteCnbCatalogCache(repository);
    const second = await createCatalog(async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("if-none-match"), '"catalog-v1"');
      return new Response(null, { status: 304 });
    }, cache);
    assert.deepEqual(await second.listVersions("paper"), ["1.21.1"]);

    const offline = await createCatalog(async () => {
      throw new Error("offline");
    }, cache);
    assert.deepEqual(await offline.listTypes(), ["paper"]);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CNB catalog rejects artifacts outside the trusted origin", () => {
  assert.throws(
    () =>
      parseCnbCatalog(
        catalogFixture(
          `https://example.invalid/SeaLantern-studio/ServerCore-Mirror/-/lfs/${artifactHash}?name=${fileName}`,
        ),
      ),
    /unsupported origin/,
  );
});

await test("server core delegates streaming and publishes into the server root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-server-core-source-"));
  const fetchImplementation = fixtureFetch();
  const catalog = await createCatalog(fetchImplementation);
  const downloads = new DownloadManager({
    fetchProvider: () => fetchImplementation,
    createId: () => "task-success",
  });
  const coordinator = new ServerCoreSourceCoordinator(catalog, exposeDownloads(downloads));

  try {
    const started = await coordinator.start({
      serverType: "paper",
      gameVersion: "1.21.1",
      serverDirectory: directory,
    });
    const completed = await waitForFinished(coordinator, started.id);

    assert.equal(completed.state, "completed");
    assert.equal(completed.destinationPath, join(directory, fileName));
    assert.equal(completed.downloadedBytes, artifactBytes.byteLength);
    assert.equal(completed.totalBytes, artifactBytes.byteLength);
    assert.equal(completed.progress, 100);
    assert.deepEqual(await readFile(join(directory, fileName)), artifactBytes);
    assert.deepEqual(await readdir(directory), [fileName]);
    await assert.rejects(
      coordinator.start({
        serverType: "paper",
        gameVersion: "1.21.1",
        serverDirectory: directory,
      }),
      /destination already exists/,
    );
  } finally {
    await coordinator.dispose();
    await downloads.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("server core checksum mismatch publishes no final file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-server-core-source-bad-hash-"));
  const fetchImplementation = fixtureFetch(Buffer.from("corrupted"));
  const catalog = await createCatalog(fetchImplementation);
  const downloads = new DownloadManager({
    fetchProvider: () => fetchImplementation,
    createId: () => "task-bad-hash",
  });
  const coordinator = new ServerCoreSourceCoordinator(catalog, exposeDownloads(downloads));

  try {
    const started = await coordinator.start({
      serverType: "paper",
      gameVersion: "1.21.1",
      serverDirectory: directory,
    });
    const failed = await waitForFinished(coordinator, started.id);

    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /checksum mismatch/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await coordinator.dispose();
    await downloads.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("server core cancellation removes the shared downloader partial file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-server-core-source-cancel-"));
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === catalogUrl) return Response.json(catalogFixture());
    if (url !== artifactUrl) return new Response("missing", { status: 404 });

    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(artifactBytes.subarray(0, 5));
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("download cancelled", "AbortError")),
          { once: true },
        );
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(artifactBytes.byteLength) },
    });
  };
  const catalog = await createCatalog(fetchImplementation);
  const downloads = new DownloadManager({
    fetchProvider: () => fetchImplementation,
    createId: () => "task-cancel",
  });
  const coordinator = new ServerCoreSourceCoordinator(catalog, exposeDownloads(downloads));

  try {
    const started = await coordinator.start({
      serverType: "paper",
      gameVersion: "1.21.1",
      serverDirectory: directory,
    });
    await waitForDownloaded(coordinator, started.id);

    assert.equal(await coordinator.cancel(started.id), true);
    assert.equal((await coordinator.snapshot(started.id))?.state, "cancelled");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await coordinator.dispose();
    await downloads.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
