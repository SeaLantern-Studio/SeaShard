export interface MinecraftTextSegment {
  readonly text: string;
  readonly color?: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underlined: boolean;
  readonly strikethrough: boolean;
  readonly obfuscated: boolean;
}

interface MinecraftTextFormatState {
  readonly color?: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underlined: boolean;
  readonly strikethrough: boolean;
  readonly obfuscated: boolean;
}

const minecraftColors: Readonly<Record<string, string>> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff",
};

const initialState: MinecraftTextFormatState = {
  bold: false,
  italic: false,
  underlined: false,
  strikethrough: false,
  obfuscated: false,
};

/**
 * 把 Minecraft Java 文本中的 § 控制符拆成可安全渲染的文本片段。
 * 控制符本身会保留在片段中，并使用它设置后的样式显示。
 */
export function parseMinecraftFormattingCodes(value: string): readonly MinecraftTextSegment[] {
  if (!value) return [];

  const segments: MinecraftTextSegment[] = [];
  let state = initialState;
  let cursor = 0;
  let plainTextStart = 0;

  const append = (text: string, segmentState: MinecraftTextFormatState): void => {
    if (!text) return;
    segments.push({ text, ...segmentState });
  };

  while (cursor < value.length) {
    if (value[cursor] !== "§") {
      cursor += 1;
      continue;
    }

    if (cursor > plainTextStart) {
      append(value.slice(plainTextStart, cursor), state);
    }

    const hexFormat = readHexFormat(value, cursor);
    if (hexFormat) {
      state = { ...state, color: hexFormat.color };
      append(value.slice(cursor, cursor + hexFormat.length), state);
      cursor += hexFormat.length;
      plainTextStart = cursor;
      continue;
    }

    const code = value[cursor + 1]?.toLowerCase();
    if (!code) {
      append("§", state);
      cursor += 1;
      plainTextStart = cursor;
      continue;
    }

    const nextState = applyFormatCode(state, code);
    if (!nextState) {
      append(value.slice(cursor, cursor + 2), state);
      cursor += 2;
      plainTextStart = cursor;
      continue;
    }

    append(value.slice(cursor, cursor + 2), nextState);
    state = nextState;
    cursor += 2;
    plainTextStart = cursor;
  }

  if (plainTextStart < value.length) append(value.slice(plainTextStart), state);
  return segments;
}

function applyFormatCode(
  state: MinecraftTextFormatState,
  code: string,
): MinecraftTextFormatState | undefined {
  const color = minecraftColors[code];
  if (color) {
    return {
      ...state,
      color,
      bold: false,
      italic: false,
      underlined: false,
      strikethrough: false,
      obfuscated: false,
    };
  }

  switch (code) {
    case "k":
      return { ...state, obfuscated: true };
    case "l":
      return { ...state, bold: true };
    case "m":
      return { ...state, strikethrough: true };
    case "n":
      return { ...state, underlined: true };
    case "o":
      return { ...state, italic: true };
    case "r":
      return initialState;
    default:
      return undefined;
  }
}

function readHexFormat(
  value: string,
  start: number,
): { readonly color: string; readonly length: number } | undefined {
  if (value[start + 1]?.toLowerCase() !== "x") return undefined;

  let color = "#";
  for (let index = 0; index < 6; index += 1) {
    const markerPosition = start + 2 + index * 2;
    if (value[markerPosition] !== "§") return undefined;
    const digit = value[markerPosition + 1];
    if (!digit || !/[0-9a-f]/iu.test(digit)) return undefined;
    color += digit;
  }
  return { color: color.toLowerCase(), length: 14 };
}
