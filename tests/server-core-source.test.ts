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
  ServerCoreIconCache,
  SQLiteCnbCatalogCache,
  parseCnbCatalog,
  parseCnbIconCatalog,
  serverCoreSourceCatalogDataCapsule,
  type CnbCatalogCache,
  type CnbCatalogCacheRecord,
  type ServerCoreDownloadTaskSnapshot,
} from "../components/server/core-source/src/index.ts";

const catalogUrl = "https://cnb.cool/test/catalog.json";
const iconCatalogUrl = "https://cnb.cool/test/icon-catalog.json";
const fileName = "paper-1.21.1.jar";
const artifactBytes = Buffer.from("SeaShard server core fixture\n", "utf8");
const iconBytes = Buffer.from(
  "SeaShard cached server core icon fixture with enough bytes for parallel ranges.",
  "utf8",
);
const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
const artifactUrl = `https://cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/lfs/${artifactHash}?name=${fileName}`;
const iconHash = createHash("sha256").update(iconBytes).digest("hex");
const rawIconUrl = `https://api.cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/lfs/${iconHash}`;
const publicIconUrl = `https://cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/lfs/${iconHash}?name=paper.png`;
const localIconUrl = `seashard-cache://server-core-icon/${iconHash}`;
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

function iconCatalogFixture(): object {
  return { paper: rawIconUrl };
}

function fixtureFetch(body = artifactBytes): typeof globalThis.fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (url === catalogUrl) {
      return Response.json(catalogFixture(), { status: 200 });
    }
    if (url === iconCatalogUrl) {
      return Response.json(iconCatalogFixture(), { status: 200 });
    }
    if (url === artifactUrl) {
      const range = new Headers(init?.headers).get("range");
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        assert.ok(match);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const chunk = body.subarray(start, end + 1);
        return new Response(chunk, {
          status: 206,
          headers: {
            "content-length": String(chunk.byteLength),
            "content-range": `bytes ${start}-${end}/${body.byteLength}`,
          },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    }
    return new Response("missing", { status: 404 });
  };
}

function iconDownloadFetch(requests: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    assert.equal(requestUrl(input), publicIconUrl);
    const range = new Headers(init?.headers).get("range");
    assert.ok(range, "shared downloader must probe and download the cached icon with ranges");
    requests.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = iconBytes.subarray(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "content-length": String(body.byteLength),
        "content-range": `bytes ${start}-${end}/${iconBytes.byteLength}`,
      },
    });
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

class MemoryCnbCatalogCache implements CnbCatalogCache {
  private readonly records = new Map<string, CnbCatalogCacheRecord>();

  async load(catalogUrl: string): Promise<CnbCatalogCacheRecord | undefined> {
    const record = this.records.get(catalogUrl);
    return record ? { ...record } : undefined;
  }

  async store(catalogUrl: string, record: CnbCatalogCacheRecord): Promise<void> {
    this.records.set(catalogUrl, { ...record });
  }

  async touch(catalogUrl: string, fetchedAt: string): Promise<void> {
    const record = this.records.get(catalogUrl);
    if (!record) throw new Error("cannot touch an empty catalog cache");
    this.records.set(catalogUrl, { ...record, fetchedAt });
  }
}

function createCatalog(
  fetchImplementation: typeof globalThis.fetch,
  cache: CnbCatalogCache = new MemoryCnbCatalogCache(),
): Promise<CnbServerCoreCatalog> {
  return CnbServerCoreCatalog.create({
    cache,
    catalogUrl,
    iconCatalogUrl,
    fetchProvider: () => fetchImplementation,
  });
}

/** 测试直接持有执行器时，用薄适配器模拟跨组件的异步 Service 边界。 */
function exposeDownloads(manager: DownloadManager): DownloadService {
  return {
    start: (request) => manager.start(request),
    snapshot: async (taskId) => manager.snapshot(taskId) ?? null,
    wait: async (taskId) => (await manager.wait(taskId)) ?? null,
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
    const url = requestUrl(input);
    if (url === catalogUrl) return Response.json(catalogFixture());
    if (url === iconCatalogUrl) return Response.json(iconCatalogFixture());
    return new Response("missing", { status: 404 });
  };
  const catalog = await createCatalog(fetchImplementation);

  assert.deepEqual(await catalog.listTypes(), [{ id: "paper" }]);
  assert.deepEqual(await catalog.listIcons(), [
    {
      serverType: "paper",
      url: publicIconUrl,
      sha256: iconHash,
    },
  ]);
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
  assert.equal(requests, 2, "artifact and icon release catalogs should each be cached");
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
    const first = await createCatalog(async (input, init) => {
      assert.equal(new Headers(init?.headers).get("if-none-match"), null);
      const url = requestUrl(input);
      if (url === catalogUrl) {
        return Response.json(catalogFixture(), {
          headers: { etag: '"catalog-v1"', "last-modified": "Sun, 16 Aug 2026 00:00:00 GMT" },
        });
      }
      assert.equal(url, iconCatalogUrl);
      return Response.json(iconCatalogFixture(), {
        headers: { etag: '"icons-v1"', "last-modified": "Sun, 16 Aug 2026 00:00:00 GMT" },
      });
    }, cache);
    assert.deepEqual(await first.listTypes(), [{ id: "paper" }]);

    // 关闭并重开 Broker，证明下一次启动读取的是用户目录中的 SQLite，而不是进程内存。
    await broker.close();
    broker = await SQLiteDatabaseBroker.create({
      databasePath,
      workerEntry: databaseWorkerEntry,
      readWorkers: 1,
    });
    repository = await broker.registerCapsule(serverCoreSourceCatalogDataCapsule);
    cache = new SQLiteCnbCatalogCache(repository);
    const second = await createCatalog(async (input, init) => {
      const expectedEtag = requestUrl(input) === catalogUrl ? '"catalog-v1"' : '"icons-v1"';
      assert.equal(new Headers(init?.headers).get("if-none-match"), expectedEtag);
      return new Response(null, { status: 304 });
    }, cache);
    assert.deepEqual(await second.listVersions("paper"), ["1.21.1"]);

    const offline = await createCatalog(async () => {
      throw new Error("offline");
    }, cache);
    assert.deepEqual(await offline.listTypes(), [{ id: "paper" }]);
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

await test("CNB icon catalog normalizes API object links and rejects other repositories", () => {
  assert.deepEqual(parseCnbIconCatalog(iconCatalogFixture()).get("paper"), {
    serverType: "paper",
    url: publicIconUrl,
    sha256: iconHash,
  });
  assert.throws(
    () =>
      parseCnbIconCatalog({
        paper: `https://api.cnb.cool/other/project/-/lfs/${iconHash}`,
      }),
    /trusted LFS identity/,
  );
});

await test("server core catalog remains usable when optional icon metadata is unavailable", async () => {
  const catalog = await createCatalog(async (input) => {
    if (requestUrl(input) === catalogUrl) return Response.json(catalogFixture());
    return new Response("missing", { status: 503 });
  });

  assert.deepEqual(await catalog.listTypes(), [{ id: "paper" }]);
  assert.deepEqual(await catalog.listVersions("paper"), ["1.21.1"]);
});

await test("server core icons download once through the shared downloader and reuse valid files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-server-core-icon-cache-"));
  const cacheDirectory = join(directory, "icons");
  const requests: string[] = [];
  const firstManager = new DownloadManager({
    fetchProvider: () => iconDownloadFetch(requests),
    minimumChunkBytes: 1,
    createId: () => "icon-cold",
  });
  let warmRequests = 0;
  const secondManager = new DownloadManager({
    fetchProvider: () => async () => {
      warmRequests += 1;
      throw new Error("warm cache must not request the icon");
    },
    minimumChunkBytes: 1,
    createId: () => "icon-warm",
  });
  const icon = parseCnbIconCatalog(iconCatalogFixture()).get("paper");
  assert.ok(icon);

  try {
    const cold = await ServerCoreIconCache.create({
      cacheDirectory,
      downloads: exposeDownloads(firstManager),
      types: [{ id: "paper" }],
      icons: [icon],
    });
    assert.deepEqual(cold.listTypes(), [{ id: "paper", iconUrl: localIconUrl }]);
    assert.equal(cold.resolvePath(iconHash), join(cacheDirectory, `${iconHash}.png`));
    assert.deepEqual(await readFile(join(cacheDirectory, `${iconHash}.png`)), iconBytes);
    assert.equal(requests.length, 9, "one probe and eight byte ranges should download the icon");
    assert.equal(firstManager.listTasks()[0]?.connections, 8);

    const warm = await ServerCoreIconCache.create({
      cacheDirectory,
      downloads: exposeDownloads(secondManager),
      types: [{ id: "paper" }],
      icons: [icon],
    });
    assert.deepEqual(warm.listTypes(), [{ id: "paper", iconUrl: localIconUrl }]);
    assert.equal(warm.resolvePath(iconHash), join(cacheDirectory, `${iconHash}.png`));
    assert.equal(warmRequests, 0);
    assert.deepEqual(secondManager.listTasks(), []);
  } finally {
    await firstManager.dispose();
    await secondManager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("server core streams downloads and numbers occupied destination names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-server-core-source-"));
  const fetchImplementation = fixtureFetch();
  const catalog = await createCatalog(fetchImplementation);
  let taskNumber = 0;
  const downloads = new DownloadManager({
    fetchProvider: () => fetchImplementation,
    createId: () => `task-success-${taskNumber++}`,
    minimumChunkBytes: 1,
  });
  const coordinator = new ServerCoreSourceCoordinator(catalog, exposeDownloads(downloads));

  try {
    const destinationFileName = "renamed-paper.jar";
    const request = {
      serverType: "paper",
      gameVersion: "1.21.1",
      destinationDirectory: directory,
      artifactFileName: fileName,
      destinationFileName,
      connections: 4,
    };
    const started = await coordinator.start(request);
    const completed = await waitForFinished(coordinator, started.id);

    assert.equal(completed.state, "completed");
    assert.equal(completed.destinationPath, join(directory, destinationFileName));
    assert.equal(completed.downloadedBytes, artifactBytes.byteLength);
    assert.equal(completed.totalBytes, artifactBytes.byteLength);
    assert.equal(completed.connections, 4);
    assert.equal(completed.progress, 100);
    assert.deepEqual(await readFile(join(directory, destinationFileName)), artifactBytes);

    const firstCopy = await coordinator.start(request);
    const firstCopyCompleted = await waitForFinished(coordinator, firstCopy.id);
    assert.equal(firstCopyCompleted.destinationPath, join(directory, "renamed-paper(1).jar"));
    assert.deepEqual(await readFile(firstCopyCompleted.destinationPath), artifactBytes);

    const secondCopy = await coordinator.start(request);
    const secondCopyCompleted = await waitForFinished(coordinator, secondCopy.id);
    assert.equal(secondCopyCompleted.destinationPath, join(directory, "renamed-paper(2).jar"));
    assert.deepEqual(await readFile(secondCopyCompleted.destinationPath), artifactBytes);
    assert.deepEqual((await readdir(directory)).sort(), [
      "renamed-paper(1).jar",
      "renamed-paper(2).jar",
      destinationFileName,
    ]);

    await assert.rejects(
      coordinator.start({
        ...request,
        destinationFileName: "../escaped.jar",
      }),
      /plain JAR file name/,
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
      destinationDirectory: directory,
      artifactFileName: fileName,
      destinationFileName: fileName,
      connections: 8,
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
      destinationDirectory: directory,
      artifactFileName: fileName,
      destinationFileName: fileName,
      connections: 8,
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
