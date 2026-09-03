import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  downloadVerifiedReleaseAsset,
  parseSeaShardReleaseCatalog,
  releaseCatalogUrl,
  resolveHostReleaseAsset,
} from "../packages/release-catalog/src/index.ts";

await test("release catalog selects the Host package type reported by Host", () => {
  const digest = "a".repeat(64);
  const release = parseSeaShardReleaseCatalog({
    schemaVersion: 1,
    version: "1.2.3",
    tag: "v1.2.3",
    assets: [
      {
        name: "SeaShard-Host-linux-x64.deb",
        size: 10,
        sha256: digest,
        downloadUrl:
          "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.2.3/SeaShard-Host-linux-x64.deb",
      },
      {
        name: "SeaShard-Host-linux-x64.AppImage",
        size: 20,
        sha256: digest,
        downloadUrl:
          "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.2.3/SeaShard-Host-linux-x64.AppImage",
      },
    ],
  });
  assert.equal(
    resolveHostReleaseAsset(release, {
      platform: "linux",
      architecture: "x64",
      packageType: "deb",
    }).name,
    "SeaShard-Host-linux-x64.deb",
  );
  assert.equal(
    releaseCatalogUrl("1.2.3"),
    "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.2.3/latest-release.json",
  );
});

await test("release download verifies byte count and SHA-256 before replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "seashard-release-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("verified release payload");
  const asset = {
    name: "payload.bin",
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    downloadUrl:
      "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v1.2.3/payload.bin",
  };
  const destination = join(root, "cache", "payload.bin");
  await downloadVerifiedReleaseAsset(asset, destination, async () => new Response(bytes));
  assert.deepEqual(await readFile(destination), bytes);

  const rejectedDestination = join(root, "cache", "rejected.bin");
  await assert.rejects(
    downloadVerifiedReleaseAsset(
      { ...asset, sha256: "0".repeat(64) },
      rejectedDestination,
      async () => new Response(bytes),
    ),
    /完整性校验失败/u,
  );
  await assert.rejects(stat(rejectedDestination), /ENOENT/u);
});
