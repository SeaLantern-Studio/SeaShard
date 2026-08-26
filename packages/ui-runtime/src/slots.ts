import type { Disposable } from "@seashard/plugin-sdk";
import type {
  ClientUiSlotChildren,
  ClientUiSlotKind,
  ClientUiSlotRegistration,
  ClientUiSlotScope,
  ClientUiSlotSpec,
} from "@seashard/ui-sdk";
import { markRaw, shallowRef, type Component, type ShallowRef } from "vue";

const slotNamePattern = /^[a-z0-9](?:[a-z0-9.:-]{0,190}[a-z0-9])?$/u;
const entryIdentityPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;

export interface RegisteredClientUiSlotEntry {
  readonly token: string;
  readonly runtimeId: string;
  readonly name: string;
  readonly component: Component;
  readonly options: ClientUiSlotRegistration;
  readonly sequence: number;
}

interface SlotRecord {
  spec?: ClientUiSlotSpec;
  declaredBy?: string;
  parent?: string;
  declarationEpoch: number;
  entries: RegisteredClientUiSlotEntry[];
  readonly declarationListeners: Set<() => void>;
}

interface SlotDispatchOptions {
  readonly entryKey?: string;
  readonly only?: string;
}

/**
 * Vue Renderer 内的 Slot 声明账本。
 *
 * 注册、子 Slot 声明和卸载共用一条所有权轴：拥有者退出时，子树会同步坍缩，
 * 已经交给调用方的旧 disposer 只会成为幂等空操作。
 */
export class ClientUiSlotRegistry {
  readonly revision: ShallowRef<number> = shallowRef(0);

  private readonly records = new Map<string, SlotRecord>();
  private readonly abdicated = new Set<string>();
  private sequence = 0;

  constructor() {
    this.declarePermanent("navigation.page", { kind: "list", scope: "root" });
    this.declarePermanent("workspace.sidebar", { kind: "keyed", scope: "root" });
  }

  register(runtimeId: string, options: ClientUiSlotRegistration, component: Component): Disposable {
    validateSlotName(options.name);
    validateInteger(options.priority, "slot priority");
    const record = this.records.get(options.name);
    if (!record?.spec) throw new Error(`UI slot is not declared: ${options.name}`);

    this.validateRegistration(record.spec.kind, options, record.entries);
    const children = validateChildren(options.children);
    for (const childName of Object.keys(children)) {
      const child = this.records.get(childName);
      if (child?.spec) {
        throw new Error(`UI slot is already declared: ${childName}`);
      }
    }

    const entry: RegisteredClientUiSlotEntry = {
      token: `ui-slot:${runtimeId}:${++this.sequence}`,
      runtimeId,
      name: options.name,
      component: markRaw(component),
      options,
      sequence: this.sequence,
    };
    record.entries = [...record.entries, entry].sort(compareEntries);
    this.bump();

    try {
      for (const [childName, spec] of Object.entries(children)) {
        this.declare(childName, spec, entry.token, options.name);
      }
    } catch (error) {
      record.entries = record.entries.filter((candidate) => candidate !== entry);
      this.releaseEntry(entry);
      this.bump();
      throw error;
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.records.get(options.name);
      if (!current?.entries.includes(entry)) return;
      current.entries = current.entries.filter((candidate) => candidate !== entry);
      this.releaseEntry(entry);
      this.bump();
    };
  }

  /** 声明一个跟随页面组件挂载期存在的根 Slot。 */
  openSurface(name: string, spec: ClientUiSlotSpec, owner: string): Disposable {
    validateSlotName(name);
    validateSlotSpec(spec, name);
    const existing = this.records.get(name);
    if (existing?.spec) throw new Error(`UI slot is already declared: ${name}`);
    this.declare(name, spec, owner);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.records.get(name);
      if (current?.declaredBy !== owner) return;
      this.collapse(name);
    };
  }

  /**
   * 把注册回调绑定到 Slot 声明期。
   *
   * 页面尚未打开时保持等待；声明出现后同步建立贡献，页面离开时先清理贡献，
   * 同一个页面再次打开会重新执行 setup。
   */
  inject(
    name: string,
    setup: () => Disposable | void,
    onDeferredError: (error: unknown) => void,
  ): Disposable {
    validateSlotName(name);
    const record = this.record(name);
    let active: Disposable | undefined;
    let activeEpoch: number | undefined;
    let stopped = false;

    const disposeActive = (): void => {
      const dispose = active;
      active = undefined;
      activeEpoch = undefined;
      if (!dispose) return;
      try {
        const result = dispose();
        if (result instanceof Promise) void result.catch(onDeferredError);
      } catch (error) {
        onDeferredError(error);
      }
    };
    const reconcile = (): void => {
      if (stopped) return;
      if (!record.spec) {
        disposeActive();
        return;
      }
      if (activeEpoch === record.declarationEpoch) return;
      disposeActive();
      active = setup() ?? undefined;
      activeEpoch = record.declarationEpoch;
    };
    const changed = (): void => {
      try {
        reconcile();
      } catch (error) {
        stopped = true;
        record.declarationListeners.delete(changed);
        disposeActive();
        onDeferredError(error);
      }
    };

    record.declarationListeners.add(changed);
    try {
      reconcile();
    } catch (error) {
      stopped = true;
      record.declarationListeners.delete(changed);
      disposeActive();
      throw error;
    }

    return () => {
      if (stopped) return;
      stopped = true;
      record.declarationListeners.delete(changed);
      disposeActive();
    };
  }

  spec(name: string): ClientUiSlotSpec | undefined {
    return this.records.get(name)?.spec;
  }

  isLive(entry: RegisteredClientUiSlotEntry): boolean {
    return this.records.get(entry.name)?.entries.includes(entry) === true;
  }

  entry(token: string): RegisteredClientUiSlotEntry | undefined {
    for (const record of this.records.values()) {
      const entry = record.entries.find((candidate) => candidate.token === token);
      if (entry) return entry;
    }
    return undefined;
  }

  entries(name: string): readonly RegisteredClientUiSlotEntry[] {
    void this.revision.value;
    return this.entriesUntracked(name);
  }

  dispatch(
    name: string,
    owner: Readonly<Record<string, unknown>>,
    options: SlotDispatchOptions = {},
  ): readonly { entry: RegisteredClientUiSlotEntry; matched?: unknown }[] {
    const record = this.records.get(name);
    if (!record?.spec) return [];
    const entries = this.entries(name);
    if (record.spec.kind === "single") {
      const entry = entries[0];
      return entry ? [{ entry }] : [];
    }
    if (record.spec.kind === "list") {
      return entries
        .filter((entry) => options.only === undefined || entry.options.id === options.only)
        .map((entry) => ({ entry }));
    }
    if (record.spec.kind === "keyed") {
      if (!options.entryKey) throw new Error(`keyed UI slot requires entryKey: ${name}`);
      const entry = entries.find((candidate) => candidate.options.key === options.entryKey);
      return entry ? [{ entry }] : [];
    }

    for (const entry of entries) {
      if (!("select" in entry.options) || typeof entry.options.select !== "function") continue;
      const matched = entry.options.select(owner);
      if (matched !== undefined && matched !== null) return [{ entry, matched }];
    }
    return [];
  }

  /** 渲染崩溃的注册让出当前 cell，下一优先级的候选可以立即接管。 */
  abdicate(token: string): void {
    const entry = this.entry(token);
    if (!entry || this.abdicated.has(token)) return;
    this.abdicated.add(token);
    this.bump();
  }

  private declarePermanent(name: string, spec: ClientUiSlotSpec): void {
    this.declare(name, spec, "ui-runtime");
  }

  private declare(name: string, spec: ClientUiSlotSpec, declaredBy: string, parent?: string): void {
    validateSlotName(name);
    validateSlotSpec(spec, name);
    const record = this.record(name);
    if (record.spec) throw new Error(`UI slot is already declared: ${name}`);
    record.spec = spec;
    record.declaredBy = declaredBy;
    record.parent = parent;
    record.declarationEpoch += 1;
    this.bump();
    for (const listener of record.declarationListeners) listener();
  }

  private collapse(name: string): void {
    const record = this.records.get(name);
    if (!record?.spec || record.declaredBy === "ui-runtime") return;
    const entries = record.entries;
    record.spec = undefined;
    record.declaredBy = undefined;
    record.parent = undefined;
    record.declarationEpoch += 1;
    record.entries = [];
    for (const entry of entries) this.releaseEntry(entry);
    this.bump();
    for (const listener of record.declarationListeners) listener();
  }

  /** 一个父 Entry 消失时，递归撤销它声明的全部 Slot 和注册。 */
  private releaseEntry(entry: RegisteredClientUiSlotEntry): void {
    this.abdicated.delete(entry.token);
    for (const childName of Object.keys(entry.options.children ?? {})) {
      const child = this.records.get(childName);
      if (child?.declaredBy === entry.token) this.collapse(childName);
    }
  }

  private entriesUntracked(name: string): readonly RegisteredClientUiSlotEntry[] {
    const record = this.records.get(name);
    if (!record?.spec) return [];
    const live = record.entries.filter((entry) => !this.abdicated.has(entry.token));
    if (record.spec.kind === "chain") return live;

    const winners: RegisteredClientUiSlotEntry[] = [];
    const occupied = new Set<string>();
    for (const entry of live) {
      const cell =
        record.spec.kind === "single"
          ? "single"
          : record.spec.kind === "keyed"
            ? `key:${entry.options.key}`
            : `id:${entry.options.id}`;
      if (occupied.has(cell)) continue;
      occupied.add(cell);
      winners.push(entry);
    }
    return winners;
  }

  private validateRegistration(
    kind: ClientUiSlotKind,
    options: ClientUiSlotRegistration,
    entries: readonly RegisteredClientUiSlotEntry[],
  ): void {
    const priority = options.priority ?? 0;
    if (kind === "single") {
      if ("id" in options && options.id !== undefined) throw slotShapeError(options.name, kind);
      if ("key" in options && options.key !== undefined) throw slotShapeError(options.name, kind);
      if (entries.some((entry) => (entry.options.priority ?? 0) === priority)) {
        throw new Error(`single UI slot already has priority ${priority}: ${options.name}`);
      }
      return;
    }
    if (kind === "list") {
      if (!("id" in options) || typeof options.id !== "string")
        throw slotShapeError(options.name, kind);
      validateEntryIdentity(options.id, "slot entry id");
      validateInteger(options.order, "slot order");
      if (
        entries.some(
          (entry) => entry.options.id === options.id && (entry.options.priority ?? 0) === priority,
        )
      ) {
        throw new Error(`list UI slot already has id ${options.id} at priority ${priority}`);
      }
      return;
    }
    if (kind === "keyed") {
      if (!("key" in options) || typeof options.key !== "string")
        throw slotShapeError(options.name, kind);
      validateEntryIdentity(options.key, "slot entry key");
      if (
        entries.some(
          (entry) =>
            entry.options.key === options.key && (entry.options.priority ?? 0) === priority,
        )
      ) {
        throw new Error(`keyed UI slot already has key ${options.key} at priority ${priority}`);
      }
      return;
    }
    if (!("select" in options) || typeof options.select !== "function") {
      throw slotShapeError(options.name, kind);
    }
  }

  private record(name: string): SlotRecord {
    let record = this.records.get(name);
    if (!record) {
      record = {
        declarationEpoch: 0,
        entries: [],
        declarationListeners: new Set(),
      };
      this.records.set(name, record);
    }
    return record;
  }

  private bump(): void {
    this.revision.value += 1;
  }
}

function compareEntries(
  left: RegisteredClientUiSlotEntry,
  right: RegisteredClientUiSlotEntry,
): number {
  return (
    (left.options.priority ?? 0) - (right.options.priority ?? 0) ||
    (left.options.order ?? 0) - (right.options.order ?? 0) ||
    left.sequence - right.sequence
  );
}

function validateChildren(children: ClientUiSlotChildren | undefined): ClientUiSlotChildren {
  if (!children) return {};
  for (const [name, spec] of Object.entries(children)) {
    validateSlotName(name);
    validateSlotSpec(spec, name);
  }
  return children;
}

function validateSlotSpec(spec: ClientUiSlotSpec, name: string): void {
  const kinds: readonly ClientUiSlotKind[] = ["single", "list", "keyed", "chain"];
  const scopes: readonly ClientUiSlotScope[] = ["root", "page"];
  if (!kinds.includes(spec.kind) || !scopes.includes(spec.scope)) {
    throw new TypeError(`invalid UI slot spec: ${name}`);
  }
}

function validateSlotName(name: string): void {
  if (!slotNamePattern.test(name)) throw new TypeError(`invalid UI slot name: ${name}`);
}

function validateEntryIdentity(value: string, label: string): void {
  if (!entryIdentityPattern.test(value)) throw new TypeError(`invalid ${label}: ${value}`);
}

function validateInteger(value: number | undefined, label: string): void {
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
}

function slotShapeError(name: string, kind: ClientUiSlotKind): TypeError {
  return new TypeError(`registration does not match ${kind} UI slot: ${name}`);
}
