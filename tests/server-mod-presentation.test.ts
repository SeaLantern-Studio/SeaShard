import assert from "node:assert/strict";
import test from "node:test";
import {
  formatServerModDownloadCount,
  formatServerModRelativeTime,
  formatServerModVersionRange,
  groupServerModVersions,
  serverModDisplayName,
  serverModDisplayTags,
} from "../frontend/server/download-mod/src/client/mod-presentation.ts";

await test("mod display names append the stable English slug only for Chinese titles", () => {
  assert.deepEqual(serverModDisplayName({ title: "暮色森林", slug: "twilight-forest" }), {
    primary: "暮色森林",
    original: "Twilight Forest",
  });
  assert.deepEqual(serverModDisplayName({ title: "Lithium", slug: "lithium" }), {
    primary: "Lithium",
  });
  assert.deepEqual(serverModDisplayName({ title: "机械动力 | Create", slug: "create-fabric" }), {
    primary: "机械动力",
    original: "Create",
  });
});

await test("mod display tags keep loaders and libraries separate from content categories", () => {
  assert.deepEqual(
    serverModDisplayTags(
      ["fabric", "forge", "library", "optimization", "utility", "unknown"],
      [
        { id: "fabric", label: "Fabric" },
        { id: "forge", label: "Forge" },
      ],
      [
        { id: "library", label: "前置 / 库" },
        { id: "optimization", label: "性能优化" },
        { id: "utility", label: "实用工具" },
      ],
    ),
    {
      categories: ["Fabric", "Forge", "前置 / 库"],
      content: ["性能优化", "实用工具"],
    },
  );
});
await test("mod download counts use at most four digits without wrapping the unit", () => {
  assert.equal(formatServerModDownloadCount(9_999), "9999");
  assert.equal(formatServerModDownloadCount(10_000), "1万");
  assert.equal(formatServerModDownloadCount(1_234_000), "123.4万");
  assert.equal(formatServerModDownloadCount(61_164_000), "6116万");
  assert.equal(formatServerModDownloadCount(99_999_999), "1亿");
  assert.equal(formatServerModDownloadCount(1_234_000_000), "12.3亿");
});

await test("mod version labels collapse patch versions into exact supported ranges", () => {
  const knownVersions = ["1.21.4", "1.20.6", "1.19.4", "1.18.2", "1.17.1", "1.16.5"].map((id) => ({
    id,
    label: id,
  }));
  assert.equal(
    formatServerModVersionRange(
      ["1.16.5", "1.17.1", "1.18.2", "1.19.4", "1.20.6", "1.21.4"],
      knownVersions,
    ),
    "1.16+",
  );
  assert.equal(
    formatServerModVersionRange(["1.16.5", "1.17.1", "1.18.2", "1.19.4", "1.20.6"], knownVersions),
    "1.16–1.20",
  );
  assert.equal(
    formatServerModVersionRange(["1.16.5", "1.18.2", "1.21.4"], knownVersions),
    "1.16、1.18、1.21",
  );
  assert.equal(formatServerModVersionRange([], knownVersions), "版本未知");
});

await test("mod update times use hour, day, week, and month grains", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  assert.equal(formatServerModRelativeTime("2026-08-18T11:40:00Z", now), "1 小时前");
  assert.equal(formatServerModRelativeTime("2026-08-18T07:00:00Z", now), "5 小时前");
  assert.equal(formatServerModRelativeTime("2026-08-16T12:00:00Z", now), "2 天前");
  assert.equal(formatServerModRelativeTime("2026-08-04T12:00:00Z", now), "2 周前");
  assert.equal(formatServerModRelativeTime("2026-06-19T12:00:00Z", now), "2 个月前");
  assert.equal(formatServerModRelativeTime("invalid", now), "刚刚");
});

await test("mod versions group by loader and game version with newest files first", () => {
  const versions = [
    {
      id: "latest-fabric",
      gameVersions: ["1.21.1", "1.20.1"],
      loaders: ["fabric"],
      fileName: "fabric-latest.jar",
      downloads: 20,
      datePublished: "2026-08-18T12:00:00Z",
    },
    {
      id: "older-shared",
      gameVersions: ["1.21.1"],
      loaders: ["fabric", "forge"],
      fileName: "shared-older.jar",
      downloads: 10,
      datePublished: "2026-08-17T12:00:00Z",
    },
    {
      id: "forge-legacy",
      gameVersions: ["1.20.1"],
      loaders: ["forge"],
      fileName: "forge-legacy.jar",
      downloads: 5,
      datePublished: "2026-08-16T12:00:00Z",
    },
  ] as const;

  const groups = groupServerModVersions(versions);
  assert.deepEqual(
    groups.map(({ id, versions: groupVersions }) => [
      id,
      groupVersions.map(({ id: versionId }) => versionId),
    ]),
    [
      ["fabric:1.21.1", ["latest-fabric", "older-shared"]],
      ["forge:1.21.1", ["older-shared"]],
      ["fabric:1.20.1", ["latest-fabric"]],
      ["forge:1.20.1", ["forge-legacy"]],
    ],
  );
  assert.deepEqual(
    groupServerModVersions(versions, "1.20.1", "forge").map(({ id }) => id),
    ["forge:1.20.1"],
  );
});
