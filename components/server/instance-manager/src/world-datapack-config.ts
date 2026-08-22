import { readFile, rename, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync, inflateSync } from "node:zlib";

const maximumNbtDepth = 64;
const maximumNbtTags = 200_000;
const maximumNbtCollectionLength = 16 * 1024 * 1024;
const datapackFileIdPrefix = "file/";

export type NbtTagType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
type NbtListElementType = 0 | NbtTagType;

type NbtTag =
  | { readonly type: 1; value: number }
  | { readonly type: 2; value: number }
  | { readonly type: 3; value: number }
  | { readonly type: 4; value: bigint }
  | { readonly type: 5; value: number }
  | { readonly type: 6; value: number }
  | { readonly type: 7; value: Uint8Array }
  | { readonly type: 8; value: string }
  | { readonly type: 9; elementType: NbtListElementType; value: NbtTag[] }
  | { readonly type: 10; value: Map<string, NbtTag> }
  | { readonly type: 11; value: number[] }
  | { readonly type: 12; value: bigint[] };

type NbtCompoundTag = Extract<NbtTag, { type: 10 }>;

interface NbtDocument {
  readonly rootName: string;
  readonly root: NbtCompoundTag;
}

/**
 * 读取 level.dat 中 Minecraft 原生的数据包禁用列表。
 * 数据包文件名保持磁盘原名，level.dat 的 Data.DataPacks 才是启用状态来源。
 */
export async function readWorldDatapackDisabledNames(
  worldDirectory: string,
): Promise<ReadonlySet<string>> {
  let source: Uint8Array;
  try {
    source = await readFile(join(worldDirectory, "level.dat"));
  } catch (error) {
    if (isMissingPathError(error)) return new Set();
    throw error;
  }

  const document = parseNbtDocument(decodeLevelDat(source));
  const data = getCompound(document.root.value.get("Data"));
  const datapacks = getCompound(data?.value.get("DataPacks"));
  const disabled = datapacks?.value.get("Disabled");
  if (!disabled) return new Set();

  return new Set(readStringList(disabled).map(normalizeDatapackFileName));
}

/** 将 Minecraft 原生数据包状态写回 level.dat，并保留文件中的其他 NBT 数据。 */
export async function writeWorldDatapackDisabled(
  worldDirectory: string,
  fileName: string,
  disabled: boolean,
): Promise<void> {
  const levelDatPath = join(worldDirectory, "level.dat");
  const details = await lstat(levelDatPath);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("世界的 level.dat 不可写入。");
  }

  const document = parseNbtDocument(decodeLevelDat(await readFile(levelDatPath)));
  const data = getOrCreateCompound(document.root.value, "Data");
  const datapacks = getOrCreateCompound(data.value, "DataPacks");
  const enabled = readOptionalStringList(datapacks.value.get("Enabled"));
  const disabledNames = readOptionalStringList(datapacks.value.get("Disabled"));
  const datapackId = `${datapackFileIdPrefix}${fileName}`;

  datapacks.value.set(
    "Enabled",
    createStringList(
      disabled
        ? removeDatapackId(enabled, fileName)
        : appendDatapackId(removeDatapackId(enabled, fileName), datapackId),
    ),
  );
  datapacks.value.set(
    "Disabled",
    createStringList(
      disabled
        ? appendDatapackId(removeDatapackId(disabledNames, fileName), datapackId)
        : removeDatapackId(disabledNames, fileName),
    ),
  );

  const temporaryPath = `${levelDatPath}.seashard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporaryPath, gzipSync(serializeNbtDocument(document)), { flag: "wx" });
    await rename(temporaryPath, levelDatPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function removeDatapackId(values: readonly string[], fileName: string): string[] {
  return values.filter((value) => !isDatapackIdForFile(value, fileName));
}

function appendDatapackId(values: readonly string[], id: string): string[] {
  return values.includes(id) ? [...values] : [...values, id];
}

function isDatapackIdForFile(id: string, fileName: string): boolean {
  return id === fileName || id === `${datapackFileIdPrefix}${fileName}`;
}

function normalizeDatapackFileName(id: string): string {
  return id.startsWith(datapackFileIdPrefix) ? id.slice(datapackFileIdPrefix.length) : id;
}

function getCompound(tag: NbtTag | undefined): NbtCompoundTag | undefined {
  return tag?.type === 10 ? tag : undefined;
}

function getOrCreateCompound(values: Map<string, NbtTag>, name: string): NbtCompoundTag {
  const existing = values.get(name);
  if (existing) {
    if (existing.type !== 10) throw new Error(`NBT 字段 ${name} 不是复合标签。`);
    return existing;
  }
  const created: NbtCompoundTag = { type: 10, value: new Map() };
  values.set(name, created);
  return created;
}

function readOptionalStringList(tag: NbtTag | undefined): string[] {
  return tag ? readStringList(tag) : [];
}

function readStringList(tag: NbtTag): string[] {
  if (tag.type !== 9 || (tag.elementType !== 8 && tag.value.length > 0)) {
    throw new Error("level.dat 的数据包列表不是字符串列表。");
  }
  return tag.value.map((value) => {
    if (value.type !== 8) throw new Error("level.dat 的数据包列表包含无效标签。");
    return value.value;
  });
}

function createStringList(values: readonly string[]): NbtTag {
  const unique = [...new Set(values)];
  return {
    type: 9,
    elementType: 8,
    value: unique.map((value) => ({ type: 8, value })),
  };
}

function decodeLevelDat(source: Uint8Array): Uint8Array {
  if (source[0] === 0x1f && source[1] === 0x8b) return gunzipSync(source);
  if (source[0] === 0x0a) return source;
  return inflateSync(source);
}

function parseNbtDocument(source: Uint8Array): NbtDocument {
  const reader = new NbtReader(source);
  const rootType = expectNbtTagType(reader.readByte());
  if (rootType !== 10) throw new Error("level.dat 的根标签不是复合标签。");
  const rootName = reader.readString();
  const root = reader.readCompound(0);
  return { rootName, root };
}

function serializeNbtDocument(document: NbtDocument): Uint8Array {
  const writer = new NbtWriter();
  writer.writeByte(10);
  writer.writeString(document.rootName);
  writer.writeCompound(document.root.value, 0);
  return writer.toUint8Array();
}

class NbtReader {
  private readonly view: DataView;
  private offset = 0;
  private tagsRead = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  }

  readByte(): number {
    this.ensure(1);
    return this.data[this.offset++]!;
  }

  readString(): string {
    const length = this.readUint16();
    const bytes = this.readBytes(length);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  readCompound(depth: number): NbtCompoundTag {
    if (depth > maximumNbtDepth) throw new Error("NBT 复合标签嵌套过深。");
    const value = new Map<string, NbtTag>();
    for (;;) {
      const typeByte = this.readByte();
      if (typeByte === 0) return { type: 10, value };
      const type = expectNbtTagType(typeByte);
      const name = this.readString();
      this.tagsRead += 1;
      if (this.tagsRead > maximumNbtTags) throw new Error("NBT 标签数量过多。");
      value.set(name, this.readPayload(type, depth + 1));
    }
  }

  private readPayload(type: NbtTagType, depth: number): NbtTag {
    switch (type) {
      case 1:
        return { type, value: this.readInt8() };
      case 2:
        return { type, value: this.readInt16() };
      case 3:
        return { type, value: this.readInt32() };
      case 4:
        return { type, value: this.readBigInt64() };
      case 5:
        return { type, value: this.readFloat32() };
      case 6:
        return { type, value: this.readFloat64() };
      case 7:
        return { type, value: this.readBytes(this.readLength("字节数组")) };
      case 8:
        return { type, value: this.readString() };
      case 9:
        return this.readList(depth);
      case 10:
        return this.readCompound(depth);
      case 11:
        return { type, value: this.readIntArray() };
      case 12:
        return { type, value: this.readLongArray() };
    }
  }

  private readList(depth: number): NbtTag {
    const elementTypeByte = this.readByte();
    const length = this.readLength("列表");
    if (length === 0) {
      if (elementTypeByte !== 0) expectNbtTagType(elementTypeByte);
      return { type: 9, elementType: elementTypeByte as NbtListElementType, value: [] };
    }
    const elementType = expectNbtTagType(elementTypeByte);
    const value: NbtTag[] = [];
    for (let index = 0; index < length; index += 1) {
      value.push(this.readPayload(elementType, depth + 1));
    }
    return { type: 9, elementType, value };
  }

  private readIntArray(): number[] {
    const length = this.readLength("整数数组");
    const value: number[] = [];
    for (let index = 0; index < length; index += 1) value.push(this.readInt32());
    return value;
  }

  private readLongArray(): bigint[] {
    const length = this.readLength("长整数数组");
    const value: bigint[] = [];
    for (let index = 0; index < length; index += 1) value.push(this.readBigInt64());
    return value;
  }

  private readLength(label: string): number {
    const length = this.readInt32();
    if (length < 0 || length > maximumNbtCollectionLength) {
      throw new Error(`NBT ${label}长度无效。`);
    }
    return length;
  }

  private readInt8(): number {
    this.ensure(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private readUint16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  private readInt16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  private readInt32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  private readBigInt64(): bigint {
    this.ensure(8);
    const value = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return value;
  }

  private readFloat32(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  private readFloat64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  private readBytes(length: number): Uint8Array {
    this.ensure(length);
    const value = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private ensure(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset > this.data.byteLength - length
    ) {
      throw new Error("NBT 数据已截断。");
    }
  }
}

class NbtWriter {
  private readonly bytes: number[] = [];

  writeByte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  writeString(value: string): void {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > 0xffff) throw new Error("NBT 字符串过长。");
    this.writeUint16(bytes.byteLength);
    this.writeBytes(bytes);
  }

  writeCompound(values: Map<string, NbtTag>, depth: number): void {
    if (depth > maximumNbtDepth) throw new Error("NBT 复合标签嵌套过深。");
    for (const [name, tag] of values) {
      this.writeByte(tag.type);
      this.writeString(name);
      this.writePayload(tag, depth + 1);
    }
    this.writeByte(0);
  }

  private writePayload(tag: NbtTag, depth: number): void {
    switch (tag.type) {
      case 1:
        this.writeInt8(tag.value);
        return;
      case 2:
        this.writeInt16(tag.value);
        return;
      case 3:
        this.writeInt32(tag.value);
        return;
      case 4:
        this.writeBigInt64(tag.value);
        return;
      case 5:
        this.writeFloat32(tag.value);
        return;
      case 6:
        this.writeFloat64(tag.value);
        return;
      case 7:
        this.writeInt32(tag.value.byteLength);
        this.writeBytes(tag.value);
        return;
      case 8:
        this.writeString(tag.value);
        return;
      case 9:
        this.writeList(tag.elementType, tag.value, depth);
        return;
      case 10:
        this.writeCompound(tag.value, depth);
        return;
      case 11:
        this.writeInt32(tag.value.length);
        for (const value of tag.value) this.writeInt32(value);
        return;
      case 12:
        this.writeInt32(tag.value.length);
        for (const value of tag.value) this.writeBigInt64(value);
        return;
    }
  }

  private writeList(
    elementType: NbtListElementType,
    values: readonly NbtTag[],
    depth: number,
  ): void {
    if (values.length > 0 && elementType === 0) throw new Error("NBT 非空列表缺少元素类型。");
    this.writeByte(elementType);
    this.writeInt32(values.length);
    for (const value of values) {
      if (value.type !== elementType) throw new Error("NBT 列表元素类型不一致。");
      this.writePayload(value, depth + 1);
    }
  }

  private writeInt8(value: number): void {
    this.writeByte(value);
  }

  private writeUint16(value: number): void {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  private writeInt16(value: number): void {
    this.writeUint16(value);
  }

  private writeInt32(value: number): void {
    this.bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  }

  private writeBigInt64(value: bigint): void {
    let normalized = BigInt.asUintN(64, value);
    const bytes = new Uint8Array(8);
    for (let index = 7; index >= 0; index -= 1) {
      bytes[index] = Number(normalized & 0xffn);
      normalized >>= 8n;
    }
    this.bytes.push(...bytes);
  }

  private writeFloat32(value: number): void {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, false);
    this.writeBytes(new Uint8Array(buffer));
  }

  private writeFloat64(value: number): void {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    this.writeBytes(new Uint8Array(buffer));
  }

  private writeBytes(value: Uint8Array): void {
    for (const byte of value) this.bytes.push(byte);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function expectNbtTagType(value: number): NbtTagType {
  if (value < 1 || value > 12 || !Number.isInteger(value)) {
    throw new Error("NBT 标签类型无效。");
  }
  return value as NbtTagType;
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
