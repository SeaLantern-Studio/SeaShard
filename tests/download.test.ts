import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DownloadManager,
  type DownloadTaskSnapshot,
} from "../components/network/download/src/index.ts";

async function waitForFinished(
  manager: DownloadManager,
  taskId: string,
): Promise<DownloadTaskSnapshot> {
  const snapshot = await manager.wait(taskId);
  if (!snapshot) throw new Error("download task disappeared");
  return snapshot;
}

await test("shared downloader resolves the current transport for every new task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-download-provider-"));
  let nextId = 0;
  let providerCalls = 0;
  let currentBody = Buffer.from("direct transport", "utf8");
  const directFetch: typeof globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("x-seashard-client"), "test");
    return new Response(currentBody, {
      status: 200,
      headers: { "content-length": String(currentBody.byteLength) },
    });
  };
  let currentFetch = directFetch;
  const manager = new DownloadManager({
    fetchProvider: () => {
      providerCalls += 1;
      return currentFetch;
    },
    defaultHeaders: { "X-SeaShard-Client": "test" },
    createId: () => `task-${++nextId}`,
  });

  try {
    const firstPath = join(directory, "first.bin");
    const first = await manager.start({
      url: "https://example.test/first.bin",
      destinationPath: firstPath,
      metadata: { source: "custom" },
    });
    const firstFinished = await waitForFinished(manager, first.id);
    assert.equal(firstFinished.state, "completed");
    assert.equal(firstFinished.connections, 1, "server ignored Range, so download must fall back");
    assert.deepEqual(await readFile(firstPath), Buffer.from("direct transport", "utf8"));

    currentBody = Buffer.from("proxy transport", "utf8");
    currentFetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-seashard-client"), "test");
      return new Response(currentBody, {
        status: 200,
        headers: { "content-length": String(currentBody.byteLength) },
      });
    };
    const secondPath = join(directory, "second.bin");
    const second = await manager.start({
      url: "https://example.test/second.bin",
      destinationPath: secondPath,
    });
    assert.equal((await waitForFinished(manager, second.id)).state, "completed");
    assert.deepEqual(await readFile(secondPath), Buffer.from("proxy transport", "utf8"));
    assert.equal(providerCalls, 2, "transport provider must run once per task");
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("shared downloader writes verified byte ranges with multiple connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-download-ranges-"));
  const source = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "utf8",
  );
  const requestedRanges: string[] = [];
  const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
    const range = new Headers(init?.headers).get("range");
    assert.ok(range, "parallel downloader must send a Range header");
    requestedRanges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = source.subarray(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "content-length": String(body.byteLength),
        "content-range": `bytes ${start}-${end}/${source.byteLength}`,
      },
    });
  };
  const manager = new DownloadManager({
    fetchProvider: () => fetchImplementation,
    defaultConnections: 4,
    minimumChunkBytes: 1,
    createId: () => "task-ranges",
  });

  try {
    const destinationPath = join(directory, "parallel.bin");
    const started = await manager.start({
      url: "https://example.test/parallel.bin",
      destinationPath,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    const completed = await waitForFinished(manager, started.id);

    assert.equal(completed.state, "completed");
    assert.equal(completed.connections, 4);
    assert.deepEqual(await readFile(destinationPath), source);
    assert.deepEqual(requestedRanges, [
      "bytes=0-0",
      "bytes=0-15",
      "bytes=16-31",
      "bytes=32-47",
      "bytes=48-63",
    ]);
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("shared downloader requires a full destination file path", async () => {
  const manager = new DownloadManager();
  try {
    await assert.rejects(
      manager.start({
        url: "https://example.test/file.bin",
        destinationPath: "relative/file.bin",
      }),
      /destinationPath must be absolute/,
    );
  } finally {
    await manager.dispose();
  }
});
