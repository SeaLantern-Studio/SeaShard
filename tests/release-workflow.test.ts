import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseBundle,
  assertReleaseVersion,
  buildReleaseNotes,
  expectedReleaseBundleNames,
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
    "SeaShard-1.2.3-macos-x64.dmg",
    "SeaShard-1.2.3-macos-arm64.dmg",
    "SeaShard-1.2.3-linux-x64.AppImage",
    "SeaShard-1.2.3-linux-x64.deb",
    "SeaShard-1.2.3-linux-arm64.AppImage",
    "SeaShard-1.2.3-linux-arm64.deb",
    "SeaShard-1.2.3-windows-x64.exe.blockmap",
    "SeaShard-1.2.3-windows-arm64.exe.blockmap",
    "latest.yml",
    "latest-arm64.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
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
    "SeaShard-Host-windows-x64.exe",
    "SeaShard-Host-windows-arm64.exe",
    "SeaShard-1.2.3-macos-x64.dmg",
    "SeaShard-1.2.3-macos-arm64.dmg",
    "SeaShard-1.2.3-linux-x64.AppImage",
    "SeaShard-1.2.3-linux-x64.deb",
    "SeaShard-1.2.3-linux-arm64.AppImage",
    "SeaShard-1.2.3-linux-arm64.deb",
  ] as const) {
    assert.match(notes, new RegExp(file.replaceAll(".", "\\."), "u"));
  }
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
