export type ConfigurationDiffLineType = "addition" | "deletion";

export interface ConfigurationDiffLine {
  type: ConfigurationDiffLineType;
  leftNumber: number | null;
  rightNumber: number | null;
  text: string;
}

interface LineAnchor {
  left: number;
  right: number;
}

const LOCAL_LCS_CELL_LIMIT = 250_000;

function normalizedLines(text: string): string[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * 只返回增删行，不混入上下文。大区段优先用 patience anchors，避免配置文件较大时
 * 创建 O(n*m) 的全量矩阵；仅在重复行构成的小区段内回退到精确 LCS。
 */
export function buildChangedConfigurationLines(
  originalText: string,
  targetText: string,
): ConfigurationDiffLine[] {
  const original = normalizedLines(originalText);
  const target = normalizedLines(targetText);
  const result: ConfigurationDiffLine[] = [];

  diffRange(original, target, 0, original.length, 0, target.length, result);
  return result;
}

function diffRange(
  original: readonly string[],
  target: readonly string[],
  originalStart: number,
  originalEnd: number,
  targetStart: number,
  targetEnd: number,
  result: ConfigurationDiffLine[],
): void {
  while (
    originalStart < originalEnd &&
    targetStart < targetEnd &&
    original[originalStart] === target[targetStart]
  ) {
    originalStart += 1;
    targetStart += 1;
  }
  while (
    originalStart < originalEnd &&
    targetStart < targetEnd &&
    original[originalEnd - 1] === target[targetEnd - 1]
  ) {
    originalEnd -= 1;
    targetEnd -= 1;
  }

  if (originalStart === originalEnd) {
    appendAdditions(target, targetStart, targetEnd, result);
    return;
  }
  if (targetStart === targetEnd) {
    appendDeletions(original, originalStart, originalEnd, result);
    return;
  }

  const anchors = patienceAnchors(
    original,
    target,
    originalStart,
    originalEnd,
    targetStart,
    targetEnd,
  );
  if (anchors.length === 0) {
    const cellCount = (originalEnd - originalStart) * (targetEnd - targetStart);
    if (cellCount <= LOCAL_LCS_CELL_LIMIT) {
      diffSmallRange(original, target, originalStart, originalEnd, targetStart, targetEnd, result);
    } else {
      appendDeletions(original, originalStart, originalEnd, result);
      appendAdditions(target, targetStart, targetEnd, result);
    }
    return;
  }

  let left = originalStart;
  let right = targetStart;
  for (const anchor of anchors) {
    diffRange(original, target, left, anchor.left, right, anchor.right, result);
    left = anchor.left + 1;
    right = anchor.right + 1;
  }
  diffRange(original, target, left, originalEnd, right, targetEnd, result);
}

function patienceAnchors(
  original: readonly string[],
  target: readonly string[],
  originalStart: number,
  originalEnd: number,
  targetStart: number,
  targetEnd: number,
): LineAnchor[] {
  const originalPositions = uniquePositions(original, originalStart, originalEnd);
  const targetPositions = uniquePositions(target, targetStart, targetEnd);
  const pairs: LineAnchor[] = [];

  for (const [line, position] of originalPositions) {
    if (position === null) continue;
    const targetPosition = targetPositions.get(line);
    if (targetPosition !== undefined && targetPosition !== null) {
      pairs.push({ left: position, right: targetPosition });
    }
  }
  pairs.sort((left, right) => left.left - right.left);
  return longestIncreasingRightSubsequence(pairs);
}

function uniquePositions(
  lines: readonly string[],
  start: number,
  end: number,
): Map<string, number | null> {
  const positions = new Map<string, number | null>();
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    positions.set(line, positions.has(line) ? null : index);
  }
  return positions;
}

function longestIncreasingRightSubsequence(pairs: readonly LineAnchor[]): LineAnchor[] {
  if (pairs.length === 0) return [];
  const pileTops: number[] = [];
  const predecessors = new Int32Array(pairs.length);
  predecessors.fill(-1);

  for (let index = 0; index < pairs.length; index += 1) {
    let low = 0;
    let high = pileTops.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[pileTops[middle]].right < pairs[index].right) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = pileTops[low - 1];
    pileTops[low] = index;
  }

  const anchors: LineAnchor[] = [];
  let cursor = pileTops[pileTops.length - 1];
  while (cursor >= 0) {
    anchors.push(pairs[cursor]);
    cursor = predecessors[cursor];
  }
  anchors.reverse();
  return anchors;
}

function diffSmallRange(
  original: readonly string[],
  target: readonly string[],
  originalStart: number,
  originalEnd: number,
  targetStart: number,
  targetEnd: number,
  result: ConfigurationDiffLine[],
): void {
  const originalLength = originalEnd - originalStart;
  const targetLength = targetEnd - targetStart;
  const width = targetLength + 1;
  const matrix = new Uint32Array((originalLength + 1) * width);

  for (let left = originalLength - 1; left >= 0; left -= 1) {
    for (let right = targetLength - 1; right >= 0; right -= 1) {
      const offset = left * width + right;
      matrix[offset] =
        original[originalStart + left] === target[targetStart + right]
          ? matrix[(left + 1) * width + right + 1] + 1
          : Math.max(matrix[(left + 1) * width + right], matrix[left * width + right + 1]);
    }
  }

  let left = 0;
  let right = 0;
  while (left < originalLength && right < targetLength) {
    if (original[originalStart + left] === target[targetStart + right]) {
      left += 1;
      right += 1;
    } else if (matrix[(left + 1) * width + right] >= matrix[left * width + right + 1]) {
      appendDeletions(original, originalStart + left, originalStart + left + 1, result);
      left += 1;
    } else {
      appendAdditions(target, targetStart + right, targetStart + right + 1, result);
      right += 1;
    }
  }
  appendDeletions(original, originalStart + left, originalEnd, result);
  appendAdditions(target, targetStart + right, targetEnd, result);
}

function appendDeletions(
  lines: readonly string[],
  start: number,
  end: number,
  result: ConfigurationDiffLine[],
): void {
  for (let index = start; index < end; index += 1) {
    result.push({ type: "deletion", leftNumber: index + 1, rightNumber: null, text: lines[index] });
  }
}

function appendAdditions(
  lines: readonly string[],
  start: number,
  end: number,
  result: ConfigurationDiffLine[],
): void {
  for (let index = start; index < end; index += 1) {
    result.push({ type: "addition", leftNumber: null, rightNumber: index + 1, text: lines[index] });
  }
}
