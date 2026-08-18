export interface SequencedValue {
  readonly sequence: number;
}

/**
 * 保存递增 sequence 的有界窗口。
 *
 * 实时事件可能先于历史补拉返回，因此窗口允许乱序插入，但永远不会保留最高序号窗口之外的对象。
 */
export class BoundedSequenceStore<T extends SequencedValue> {
  private readonly entries = new Map<number, T>();
  private highestSequence = 0;
  private minimumSequence = 1;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("sequence store limit must be a positive safe integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  add(value: T): boolean {
    const sequence = value.sequence;
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new TypeError("sequence must be a positive safe integer");
    }
    if (sequence < this.minimumSequence || this.entries.has(sequence)) return false;

    if (sequence > this.highestSequence) {
      const nextMinimum = Math.max(1, sequence - this.limit + 1);
      this.evictBefore(nextMinimum);
      this.highestSequence = sequence;
    }
    if (sequence < this.minimumSequence) return false;
    this.entries.set(sequence, value);
    return true;
  }

  values(): readonly T[] {
    return [...this.entries.values()].sort((left, right) => left.sequence - right.sequence);
  }

  clear(): void {
    this.entries.clear();
    this.highestSequence = 0;
    this.minimumSequence = 1;
  }

  private evictBefore(nextMinimum: number): void {
    if (nextMinimum <= this.minimumSequence) return;
    if (nextMinimum - this.minimumSequence >= this.limit) {
      this.entries.clear();
    } else {
      for (let sequence = this.minimumSequence; sequence < nextMinimum; sequence += 1) {
        this.entries.delete(sequence);
      }
    }
    this.minimumSequence = nextMinimum;
  }
}
