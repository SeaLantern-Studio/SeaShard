/** 只接受真实图片签名，避免把任意 JAR 内容作为 Renderer 图片传递。 */
export function imageBytesToDataUrl(
  value: Uint8Array | undefined,
  maximumBytes: number,
): string | undefined {
  if (!value || value.byteLength > maximumBytes) return undefined;
  const mimeType = detectImageMimeType(value);
  return mimeType ? `data:${mimeType};base64,${Buffer.from(value).toString("base64")}` : undefined;
}

function detectImageMimeType(
  value: Uint8Array,
): "image/png" | "image/gif" | "image/jpeg" | "image/webp" | undefined {
  if (
    value.byteLength >= 8 &&
    value[0] === 0x89 &&
    value[1] === 0x50 &&
    value[2] === 0x4e &&
    value[3] === 0x47 &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    value.byteLength >= 6 &&
    value[0] === 0x47 &&
    value[1] === 0x49 &&
    value[2] === 0x46 &&
    value[3] === 0x38 &&
    (value[4] === 0x37 || value[4] === 0x39) &&
    value[5] === 0x61
  ) {
    return "image/gif";
  }
  if (value.byteLength >= 2 && value[0] === 0xff && value[1] === 0xd8) return "image/jpeg";
  if (
    value.byteLength >= 12 &&
    value[0] === 0x52 &&
    value[1] === 0x49 &&
    value[2] === 0x46 &&
    value[3] === 0x46 &&
    value[8] === 0x57 &&
    value[9] === 0x45 &&
    value[10] === 0x42 &&
    value[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}
