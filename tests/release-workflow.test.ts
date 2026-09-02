import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReleaseBundle,
  assertReleaseVersion,
  buildReleaseCatalog,
  buildReleaseNotes,
  expectedPublishedReleaseAssetNames,
  expectedReleaseBundleNames,
  generateReleaseCatalog,
} from "../scripts/generate-release-notes.ts";

await test("manual release accepts only unprefixed three-part numeric versions", () => {
  assert.doesNotThrow(() => assertReleaseVersion("1.0.0"));
  for (const invalid of ["v1.0.0", "1.0", "1.0.0.0", "1.0.beta", " 1.0.0"] as const) {
    assert.throws(() => assertReleaseVersion(invalid), /不带 v 的三段数字格式/u);
  }
});

await test("release bundle includes installers and supported updater metadata", () => {
  const bundle = expectedReleaseBundleNames("1.2.3");
  assert.deepEqual(bundle, [
    "SeaShard-1.2.3-windows-x64.exe",
    "SeaShard-1.2.3-windows-arm64.exe",
    "SeaShard-Host-windows-x64.exe",
    "SeaShard-Host-windows-arm64.exe",
    "SeaShard-1.2.3-macos-x64.pkg",
    "SeaShard-1.2.3-macos-arm64.pkg",
    "SeaShard-Host-macos-x64.pkg",
    "SeaShard-Host-macos-arm64.pkg",
    "SeaShard-1.2.3-linux-x64.AppImage",
    "SeaShard-1.2.3-linux-x64.deb",
    "SeaShard-1.2.3-linux-arm64.AppImage",
    "SeaShard-1.2.3-linux-arm64.deb",
    "SeaShard-Host-linux-x64.AppImage",
    "SeaShard-Host-linux-x64.deb",
    "SeaShard-Host-linux-arm64.AppImage",
    "SeaShard-Host-linux-arm64.deb",
    "SeaShard-1.2.3-windows-x64.exe.blockmap",
    "SeaShard-1.2.3-windows-arm64.exe.blockmap",
    "latest.yml",
    "latest-arm64.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
    "latest-release.json",
    "release-notes.md",
  ]);
  assert.doesNotThrow(() => assertReleaseBundle("1.2.3", bundle));
  assert.throws(
    () =>
      assertReleaseBundle(
        "1.2.3",
        bundle.filter((name) => name !== "latest-linux.yml"),
      ),
    /缺少 Release 资产：latest-linux\.yml/u,
  );
});

await test("release catalog indexes every published product without GitHub API metadata", () => {
  const version = "1.2.3";
  const names = expectedPublishedReleaseAssetNames(version);
  const catalog = JSON.parse(
    buildReleaseCatalog(
      version,
      "SeaLantern-Studio/SeaShard",
      names.map((name, index) => ({
        name,
        size: index + 1,
        sha256: index.toString(16).padStart(64, "0"),
      })),
    ),
  ) as {
    schemaVersion: number;
    version: string;
    tag: string;
    assets: Array<{ name: string; size: number; sha256: string; downloadUrl: string }>;
  };

  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.version, version);
  assert.equal(catalog.tag, `v${version}`);
  assert.deepEqual(
    catalog.assets.map(({ name }) => name),
    names,
  );
  assert.match(
    catalog.assets.find(({ name }) => name === "SeaShard-Host-linux-x64.deb")!.downloadUrl,
    /releases\/download\/v1\.2\.3\/SeaShard-Host-linux-x64\.deb$/u,
  );
  assert.ok(catalog.assets.some(({ name }) => name === "latest-linux.yml"));
});

await test("release catalog writer hashes the exact published asset bundle", async (t) => {
  const version = "1.2.3";
  const directory = await mkdtemp(join(tmpdir(), "seashard-release-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = expectedPublishedReleaseAssetNames(version);
  const contents = new Map(names.map((name) => [name, `asset:${name}`]));
  await Promise.all([
    ...names.map((name) => writeFile(join(directory, name), contents.get(name)!, "utf8")),
    writeFile(join(directory, "release-notes.md"), "release notes\n", "utf8"),
  ]);

  const output = join(directory, "latest-release.json");
  await generateReleaseCatalog(version, "SeaLantern-Studio/SeaShard", directory, output);
  const generatedNames = await readdir(directory);
  assert.doesNotThrow(() => assertReleaseBundle(version, generatedNames));

  const catalog = JSON.parse(await readFile(output, "utf8")) as {
    assets: Array<{ name: string; size: number; sha256: string }>;
  };
  const hostName = "SeaShard-Host-linux-x64.deb";
  const host = catalog.assets.find(({ name }) => name === hostName);
  const content = contents.get(hostName)!;
  assert.equal(host?.size, Buffer.byteLength(content));
  assert.equal(host?.sha256, createHash("sha256").update(content).digest("hex"));
});

await test("release notes map every supported platform and include the complete commit range", () => {
  const notes = buildReleaseNotes({
    version: "1.2.3",
    repository: "SeaLantern-Studio/SeaShard",
    currentSha: "c".repeat(40),
    previousTag: "v1.2.2",
    commits: [
      { sha: "a".repeat(40), subject: "feat(plugin): 添加插件市场" },
      { sha: "b".repeat(40), subject: "fix(runtime): 修复重载" },
    ],
  });

  for (const file of [
    "SeaShard-1.2.3-windows-x64.exe",
    "SeaShard-1.2.3-windows-arm64.exe",
    "SeaShard-1.2.3-macos-x64.pkg",
    "SeaShard-1.2.3-macos-arm64.pkg",
    "SeaShard-1.2.3-linux-x64.AppImage",
    "SeaShard-1.2.3-linux-x64.deb",
    "SeaShard-1.2.3-linux-arm64.AppImage",
    "SeaShard-1.2.3-linux-arm64.deb",
  ] as const) {
    assert.match(notes, new RegExp(file.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(
    notes,
    /SeaShard-Host-(?:windows|macos|linux)-(?:x64|arm64)\.(?:exe|pkg|AppImage|deb)/u,
  );
  assert.match(notes, /^## 下载指引/u);
  assert.doesNotMatch(notes, /^# SeaShard /u);
  assert.match(notes, /feat\(plugin\): 添加插件市场/u);
  assert.match(notes, /fix\(runtime\): 修复重载/u);
  assert.match(notes, /compare\/v1\.2\.2\.\.\.v1\.2\.3/u);
  assert.match(notes, /当前构建未进行商业代码签名/u);
});

await test("first release notes include repository history without a previous comparison tag", () => {
  const notes = buildReleaseNotes({
    version: "0.1.0",
    repository: "SeaLantern-Studio/SeaShard",
    currentSha: "d".repeat(40),
    commits: [{ sha: "d".repeat(40), subject: "feat(core): 建立项目" }],
  });

  assert.match(notes, /首个公开 Release/u);
  assert.match(notes, /commit\/dddddddddddddddddddddddddddddddddddddddd/u);
  assert.doesNotMatch(notes, /\/compare\//u);
});
