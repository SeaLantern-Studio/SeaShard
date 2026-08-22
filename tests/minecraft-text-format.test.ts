import assert from "node:assert/strict";
import test from "node:test";
import { parseMinecraftFormattingCodes } from "../frontend/server/saves/src/client/minecraft-text-format.ts";

await test("Minecraft control symbols stay visible and color following text", () => {
  const source = "§6§lVeinminer §7| §61.21.5+ §eBy Miraculixx";
  const segments = parseMinecraftFormattingCodes(source);

  assert.equal(segments.map(({ text }) => text).join(""), source);
  assert.deepEqual(
    segments.slice(0, 7).map(({ text, color, bold }) => ({ text, color, bold })),
    [
      { text: "§6", color: "#ffaa00", bold: false },
      { text: "§l", color: "#ffaa00", bold: true },
      { text: "Veinminer ", color: "#ffaa00", bold: true },
      { text: "§7", color: "#aaaaaa", bold: false },
      { text: "| ", color: "#aaaaaa", bold: false },
      { text: "§6", color: "#ffaa00", bold: false },
      { text: "1.21.5+ ", color: "#ffaa00", bold: false },
    ],
  );
  assert.equal(segments[7]?.text, "§e");
  assert.equal(segments[7]?.color, "#ffff55");
  assert.equal(segments[8]?.text, "By Miraculixx");
  assert.equal(segments[8]?.color, "#ffff55");
});

await test("Minecraft reset, style, and hex control symbols preserve the source", () => {
  const source = "§c红§n下划线§m删除线§r普通§x§1§2§3§4§5§6Hex";
  const segments = parseMinecraftFormattingCodes(source);

  assert.equal(segments.map(({ text }) => text).join(""), source);
  assert.equal(segments[0]?.color, "#ff5555");
  assert.equal(segments[2]?.underlined, true);
  assert.equal(segments[4]?.strikethrough, true);
  assert.equal(segments[6]?.color, undefined);
  assert.equal(segments[8]?.color, "#123456");
  assert.equal(segments[8]?.text, "§x§1§2§3§4§5§6");
  assert.equal(segments[9]?.text, "Hex");
  assert.equal(segments[9]?.color, "#123456");
});

await test("unknown or incomplete control symbols remain ordinary visible text", () => {
  const source = "前缀§z未知§";
  const segments = parseMinecraftFormattingCodes(source);

  assert.equal(segments.map(({ text }) => text).join(""), source);
  assert.equal(segments[0]?.text, "前缀");
  assert.equal(segments[1]?.text, "§z");
  assert.equal(segments[2]?.text, "未知");
  assert.equal(segments[3]?.text, "§");
});
