import { randomBytes } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRecord } from "./codec";
import { sessionVersion, titleSlotBytes } from "./records";

/** 第一版 Journal 在 Host 启动时原地升级；临时文件完成后再 rename，崩溃不会留下半份记录。 */
export async function migrateVersionOneSessions(sessionsRoot: string): Promise<void> {
  const names = await readdir(sessionsRoot);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => migrateVersionOneSession(join(sessionsRoot, name), name)),
  );
}

async function migrateVersionOneSession(path: string, fileName: string): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.length < titleSlotBytes || bytes[titleSlotBytes - 1] !== 0x0a) {
    throw new Error(`Agent Session 标题槽损坏：${fileName}`);
  }
  const lines = bytes.subarray(titleSlotBytes).toString("utf8").trim().split("\n");
  const header = parseRecord(lines[0] ?? "");
  if (header.version === sessionVersion) return;
  if (header.type !== "session" || header.version !== 1) {
    throw new Error(`Agent Session 版本不受支持：${fileName}`);
  }
  const records = lines.map((line, index) => {
    const record = parseRecord(line);
    if (index === 0) return { ...record, version: sessionVersion };
    if (
      record.type === "message" &&
      typeof record.content === "string" &&
      record.contentBlocks === undefined
    ) {
      return {
        ...record,
        contentBlocks: record.content ? [{ type: "text", text: record.content }] : [],
      };
    }
    return record;
  });
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.migrate`;
  try {
    await writeFile(
      temporaryPath,
      Buffer.concat([
        bytes.subarray(0, titleSlotBytes),
        Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
      ]),
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
