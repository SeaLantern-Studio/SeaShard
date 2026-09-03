import {
  clientPluginAssetScheme,
  type ClientEntryDescriptor,
  type ClientEntryPublication,
  type ClientServiceCallRequest,
} from "@seashard/contracts";
import type { Disposable, JsonValue } from "@seashard/plugin-sdk";
import {
  pageRootSlot,
  type ClientUiContext,
  type ClientServerSelection,
  type ClientUiModule,
  type ClientUiRenderSlot,
  type ClientUiRenderSlotOptions,
  type ClientUiSlotRegistration,
  type NavigationPageSlotRegistration,
  type PageRootExtensionMode,
  type PageRootExtensionSlotRegistration,
} from "@seashard/ui-sdk";
import {
  computed,
  defineComponent,
  effectScope,
  h,
  inject,
  onErrorCaptured,
  ref,
  shallowRef,
  type Component,
  type ComputedRef,
  type EffectScope,
  type InjectionKey,
  type PropType,
  type VNodeChild,
} from "vue";
import type { Router } from "vue-router";
import { ClientUiSlotRegistry, type RegisteredClientUiSlotEntry } from "./slots";

export * from "./slots";

export interface ClientUiModuleLoader {
  load(): Promise<unknown>;
}

export interface ClientUiPackageModuleLoader {
  load(moduleUrl: string, integrity: string): Promise<unknown>;
}

export interface ClientUiHostServiceBridge {
  call(request: ClientServiceCallRequest): Promise<JsonValue | void>;
}

export interface ClientUiServiceAdapterContext {
  readonly entry: ClientEntryDescriptor;
  call(method: string, args: readonly JsonValue[]): Promise<JsonValue | void>;
  effect(setup: () => Disposable): Disposable;
}

export type ClientUiServiceAdapter = (context: ClientUiServiceAdapterContext) => object;

/** 浏览器端只接受 Main 发布的摘要协议 URL，禁止把普通网络地址送入动态 import。 */
export const browserClientPackageModuleLoader: ClientUiPackageModuleLoader = {
  load: async (moduleUrl, integrity) => {
    const url = new URL(moduleUrl);
    if (
      url.protocol !== `${clientPluginAssetScheme}:` ||
      url.hostname !== integrity ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(`invalid client package module URL: ${moduleUrl}`);
    }
    return import(/* @vite-ignore */ url.href);
  },
};

export interface ClientUiRuntimeOptions {
  router: Router;
  builtInLoaders: Readonly<Record<string, ClientUiModuleLoader>>;
  packageLoader: ClientUiPackageModuleLoader;
  hostServices: ClientUiHostServiceBridge;
  serviceAdapters?: Readonly<Record<string, ClientUiServiceAdapter>>;
  serverSelection: ClientServerSelection;
  services: Readonly<Record<string, object>>;
}

export interface RegisteredNavigationPage extends Omit<
  NavigationPageSlotRegistration,
  "name" | "children"
> {
  readonly runtimeId: string;
  readonly routeName: string;
  readonly entryToken: string;
  readonly component: Component;
}

export interface RegisteredWorkspaceSidebar {
  readonly runtimeId: string;
  readonly workspaceId: string;
  readonly entryToken: string;
  readonly component: Component;
}

export interface RegisteredPageRootExtension {
  readonly runtimeId: string;
  readonly id: string;
  readonly entryToken: string;
  readonly component: Component;
  readonly mode: PageRootExtensionMode;
  readonly order?: number;
  readonly priority?: number;
}

export interface ClientUiFailure {
  runtimeId: string;
  stage: "activation" | "bootstrap" | "render" | "teardown";
  message: string;
}

interface ActiveClientEntry {
  descriptor: ClientEntryDescriptor;
  fingerprint: string;
  scope: EffectScope;
  disposers: Set<Disposable>;
  callable: boolean;
}
const navigationPagePlacements = [
  "main",
  "settings",
  "agent-settings",
  "server",
  "server-download",
] as const;

const contributionIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;

/**
 * 每个 Renderer 独立拥有的轻量 UI Runtime。
 *
 * Main 只发布期望 Entry；该 Runtime 负责本地 Vue Scope、页面注册、渐进故障和清理。
 */
export class ClientUiRuntime {
  readonly ready = shallowRef(false);
  readonly pages: ComputedRef<readonly RegisteredNavigationPage[]>;
  readonly workspaceSidebars: ComputedRef<readonly RegisteredWorkspaceSidebar[]>;
  readonly failures: ComputedRef<readonly ClientUiFailure[]>;

  private readonly active = new Map<string, ActiveClientEntry>();
  private readonly slots = new ClientUiSlotRegistry();
  private readonly pageIdsByPath = new Map<string, string>();
  private pageSurfaceSequence = 0;
  private readonly failuresByRuntime = new Map<string, ClientUiFailure>();
  private readonly failureVersion = shallowRef(0);
  private reconcileQueue: Promise<void> = Promise.resolve();
  private revision = -1;

  constructor(private readonly options: ClientUiRuntimeOptions) {
    this.pages = computed(() =>
      this.slots
        .entries("navigation.page")
        .map(projectNavigationPage)
        .sort(
          (left, right) =>
            (left.order ?? 0) - (right.order ?? 0) || left.label.localeCompare(right.label),
        ),
    );
    this.workspaceSidebars = computed(() =>
      this.slots
        .entries("workspace.sidebar")
        .map(projectWorkspaceSidebar)
        .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
    );
    this.failures = computed(() => {
      void this.failureVersion.value;
      return [...this.failuresByRuntime.values()].sort((left, right) =>
        left.runtimeId.localeCompare(right.runtimeId),
      );
    });
  }

  reconcile(publication: ClientEntryPublication): Promise<void> {
    const task = this.reconcileQueue.then(() => this.applyPublication(publication));
    this.reconcileQueue = task.catch(() => {});
    return task;
  }

  failBootstrap(error: unknown): void {
    this.recordFailure("renderer.bootstrap", "bootstrap", error);
    this.ready.value = true;
  }

  reportRenderFailure(runtimeId: string, error: unknown): void {
    this.recordFailure(runtimeId, "render", error);
  }

  clearRenderFailure(runtimeId: string): void {
    if (this.failuresByRuntime.get(runtimeId)?.stage !== "render") return;
    this.failuresByRuntime.delete(runtimeId);
    this.failureVersion.value += 1;
  }

  /** 页面组件挂载时声明根 Slot；离开页面会级联撤销其全部扩展。 */
  openPageRoot(pageId: string): Disposable {
    const name = pageRootSlot(pageId);
    const owner = `page-surface:${pageId}:${++this.pageSurfaceSequence}`;
    return this.slots.openSurface(name, { kind: "list", scope: "page" }, owner);
  }

  pageRootExtensions(pageId: string): readonly RegisteredPageRootExtension[] {
    return this.slots.entries(pageRootSlot(pageId)).map(projectPageRootExtension);
  }

  slotEntries(name: string): readonly RegisteredClientUiSlotEntry[] {
    return this.slots.entries(name);
  }

  renderSlot(
    name: string,
    owner: Readonly<Record<string, unknown>> = {},
    options: ClientUiRenderSlotOptions = {},
  ): VNodeChild {
    const dispatched = this.slots.dispatch(name, owner, options);
    if (!dispatched.length) return options.fallback;
    return dispatched.map(({ entry, matched }) =>
      this.renderRegisteredSlotEntry(entry, owner, matched),
    );
  }

  renderSlotEntry(entryToken: string, owner: Readonly<Record<string, unknown>> = {}): VNodeChild {
    const entry = this.slots.entry(entryToken);
    return entry ? this.renderRegisteredSlotEntry(entry, owner, undefined) : null;
  }

  reportSlotRenderFailure(entryToken: string, runtimeId: string, error: unknown): void {
    this.slots.abdicate(entryToken);
    this.reportRenderFailure(runtimeId, error);
  }

  dispose(): Promise<void> {
    const task = this.reconcileQueue.then(async () => {
      for (const record of [...this.active.values()].reverse()) {
        await this.stopEntry(record);
      }
      this.active.clear();
      this.ready.value = false;
    });
    this.reconcileQueue = task.catch(() => {});
    return task;
  }

  private async applyPublication(publication: ClientEntryPublication): Promise<void> {
    if (!Number.isSafeInteger(publication.revision) || publication.revision < 0) {
      throw new TypeError("client entry publication revision must be a non-negative integer");
    }
    if (publication.revision < this.revision) return;

    const desired = new Map(publication.entries.map((entry) => [entry.runtimeId, entry]));
    for (const [runtimeId, record] of this.active) {
      const descriptor = desired.get(runtimeId);
      if (descriptor && fingerprintDescriptor(descriptor) === record.fingerprint) continue;
      try {
        await this.stopEntry(record);
      } catch (error) {
        this.recordFailure(runtimeId, "teardown", error);
      }
      this.active.delete(runtimeId);
      if (!descriptor) this.removeFailure(runtimeId);
    }

    for (const descriptor of [...desired.values()].sort((left, right) =>
      left.runtimeId.localeCompare(right.runtimeId),
    )) {
      if (this.active.has(descriptor.runtimeId)) continue;
      this.removeFailure(descriptor.runtimeId);
      await this.startEntry(descriptor);
    }

    this.revision = publication.revision;
    this.ready.value = true;
  }

  private async startEntry(descriptor: ClientEntryDescriptor): Promise<void> {
    const scope = effectScope(true);
    const disposers = new Set<Disposable>();
    const record: ActiveClientEntry = {
      descriptor,
      fingerprint: fingerprintDescriptor(descriptor),
      scope,
      disposers,
      callable: true,
    };

    try {
      const module = resolveClientUiModule(await this.loadEntryModule(descriptor));
      const registerSlot = (options: ClientUiSlotRegistration, component: Component): Disposable =>
        this.ownEffect(record, () =>
          this.registerClientSlot(descriptor.runtimeId, options, component),
        );
      const callClientService = (
        contract: string,
        method: string,
        args: readonly JsonValue[],
      ): Promise<JsonValue | void> => {
        if (!record.callable) {
          return Promise.reject(
            new Error(`client runtime is no longer active: ${descriptor.runtimeId}`),
          );
        }
        return this.options.hostServices.call({
          runtimeId: descriptor.runtimeId,
          integrity: descriptor.integrity,
          contract,
          method,
          args,
        });
      };
      const context: ClientUiContext = {
        entry: descriptor,
        slots: {
          register: registerSlot,
          inject: (name, setup) =>
            this.ownEffect(record, () =>
              this.slots.inject(name, setup, (error) =>
                this.recordFailure(descriptor.runtimeId, "render", error),
              ),
            ),
        },
        serverSelection: {
          getCurrentInstanceId: () => {
            if (!record.callable) {
              throw new Error(`client runtime is no longer active: ${descriptor.runtimeId}`);
            }
            return this.options.serverSelection.getCurrentInstanceId();
          },
          subscribe: (listener) => {
            if (!record.callable) {
              throw new Error(`client runtime is no longer active: ${descriptor.runtimeId}`);
            }
            if (typeof listener !== "function") {
              throw new TypeError("server selection listener must be a function");
            }
            return this.ownEffect(record, () => this.options.serverSelection.subscribe(listener));
          },
        },
        service: <T extends object>(contract: string): T => {
          const local = this.options.services[contract];
          if (local) return local as T;
          const adapter = this.options.serviceAdapters?.[contract];
          if (adapter) {
            return adapter({
              entry: descriptor,
              call: (method, args) => callClientService(contract, method, args),
              effect: (setup) => this.ownEffect(record, setup),
            }) as T;
          }
          return new Proxy(
            {},
            {
              get: (_target, property) => {
                if (property === "then") return undefined;
                if (typeof property !== "string") return undefined;
                return (...args: JsonValue[]) => callClientService(contract, property, args);
              },
            },
          ) as T;
        },
        effect: (setup) => this.ownEffect(record, setup),
      };

      const cleanup = await scope.run(() => module.apply(context, descriptor.config));
      if (cleanup) this.ownEffect(record, () => cleanup);
      this.active.set(descriptor.runtimeId, record);
    } catch (error) {
      try {
        await this.stopEntry(record);
      } catch (cleanupError) {
        this.recordFailure(
          descriptor.runtimeId,
          "activation",
          new AggregateError([error, cleanupError], "client entry activation and cleanup failed"),
        );
        return;
      }
      this.recordFailure(descriptor.runtimeId, "activation", error);
    }
  }

  private loadEntryModule(descriptor: ClientEntryDescriptor): Promise<unknown> {
    if (descriptor.module.source === "package") {
      return this.options.packageLoader.load(descriptor.module.url, descriptor.integrity);
    }
    const loader = this.options.builtInLoaders[descriptor.module.key];
    if (!loader) {
      throw new Error(`client module loader is unavailable: ${descriptor.module.key}`);
    }
    return loader.load();
  }

  private registerClientSlot(
    runtimeId: string,
    options: ClientUiSlotRegistration,
    component: Component,
  ): Disposable {
    if (options.name === "navigation.page") {
      return this.registerNavigationPage(
        runtimeId,
        options as NavigationPageSlotRegistration,
        component,
      );
    }
    if (options.name.startsWith("page.") && options.name.endsWith(".root")) {
      const mode = (options as PageRootExtensionSlotRegistration).mode;
      if (
        mode !== undefined &&
        !(["prepend", "append", "overlay", "replace", "dom"] as const).includes(mode)
      ) {
        throw new TypeError(`invalid page root extension mode: ${String(mode)}`);
      }
    }
    return this.slots.register(runtimeId, options, component);
  }

  private registerNavigationPage(
    runtimeId: string,
    page: NavigationPageSlotRegistration,
    component: Component,
  ): Disposable {
    if (!contributionIdPattern.test(page.id)) {
      throw new TypeError(`invalid navigation page id: ${page.id}`);
    }
    if (!page.path.startsWith("/") || page.path === "/") {
      throw new TypeError(`navigation page path must be a non-root absolute path: ${page.path}`);
    }
    if (page.placement !== undefined && !navigationPagePlacements.includes(page.placement)) {
      throw new TypeError(`invalid navigation page placement: ${String(page.placement)}`);
    }
    if (page.placement === "server") {
      if (!page.path.startsWith("/server/")) {
        throw new TypeError(`server navigation page must use a /server/ path: ${page.path}`);
      }
      if (page.path.split("/")[2] === "download") {
        throw new TypeError(
          `server navigation page cannot use the reserved download path: ${page.path}`,
        );
      }
    }
    if (!page.label.trim()) throw new TypeError("navigation page label must not be empty");
    if (this.slots.entries("navigation.page").some((entry) => entry.options.id === page.id)) {
      throw new Error(`navigation page id is already registered: ${page.id}`);
    }
    const existingPath = this.pageIdsByPath.get(page.path);
    if (existingPath) {
      throw new Error(
        `navigation page path is already registered: ${page.path} by ${existingPath}`,
      );
    }

    const disposeSlot = this.slots.register(runtimeId, page, component);
    const routeName = routeNameForPage(runtimeId, page.id);
    let removeRoute: Disposable;
    try {
      removeRoute = this.options.router.addRoute({
        name: routeName,
        path: page.path,
        component,
        meta: { runtimeId, pageId: page.id },
      });
    } catch (error) {
      void disposeSlot();
      throw error;
    }
    this.pageIdsByPath.set(page.path, page.id);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      void removeRoute();
      if (this.pageIdsByPath.get(page.path) === page.id) {
        this.pageIdsByPath.delete(page.path);
      }
      return disposeSlot();
    };
  }

  private renderRegisteredSlotEntry(
    entry: RegisteredClientUiSlotEntry,
    owner: Readonly<Record<string, unknown>>,
    matched: unknown,
  ): VNodeChild {
    const props: Record<string, unknown> = { ...owner };
    if (matched !== undefined) props.matched = matched;
    const children = entry.options.children;
    if (children) {
      const renderSlot: ClientUiRenderSlot = (name, childOwner = {}, options = {}) => {
        if (!(name in children)) {
          throw new Error(`UI slot is outside the entry declaration: ${name}`);
        }
        if (!this.slots.isLive(entry)) {
          throw new Error(`UI slot owner is no longer active: ${entry.token}`);
        }
        return this.renderSlot(name, childOwner, options);
      };
      props.renderSlot = renderSlot;
    }

    return h(
      ClientUiSlotEntryBoundary,
      {
        key: entry.token,
        entryToken: entry.token,
        runtimeId: entry.runtimeId,
      },
      {
        default: () => h(entry.component, props),
      },
    );
  }

  /** 所有 Effect 都返回幂等 disposer，并在提前清理后从 Entry 账本移除。 */
  private ownEffect(record: ActiveClientEntry, setup: () => Disposable | void): Disposable {
    const cleanup = setup();
    let active = true;
    const owned: Disposable = () => {
      if (!active) return;
      active = false;
      record.disposers.delete(owned);
      return cleanup?.();
    };
    record.disposers.add(owned);
    return owned;
  }

  private async stopEntry(record: ActiveClientEntry): Promise<void> {
    record.callable = false;
    const failures: unknown[] = [];
    for (const dispose of [...record.disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    record.scope.stop();
    if (failures.length) throw new AggregateError(failures, "client entry teardown failed");
  }

  private recordFailure(runtimeId: string, stage: ClientUiFailure["stage"], error: unknown): void {
    this.failuresByRuntime.set(runtimeId, {
      runtimeId,
      stage,
      message: error instanceof Error ? error.message : String(error),
    });
    this.failureVersion.value += 1;
  }

  private removeFailure(runtimeId: string): void {
    if (!this.failuresByRuntime.delete(runtimeId)) return;
    this.failureVersion.value += 1;
  }
}

export const clientUiRuntimeKey: InjectionKey<ClientUiRuntime> = Symbol(
  "seashard.client-ui-runtime",
);

export function useClientUiRuntime(): ClientUiRuntime {
  const runtime = inject(clientUiRuntimeKey);
  if (!runtime) throw new Error("ClientUiRuntime was not provided");
  return runtime;
}

/** 通用 Slot Outlet；第三方拥有者通过 renderSlot prop 获得同一能力。 */
export const ClientUiSlotOutlet = defineComponent({
  name: "ClientUiSlotOutlet",
  props: {
    name: { type: String, required: true },
    owner: {
      type: Object as PropType<Readonly<Record<string, unknown>>>,
      default: () => ({}),
    },
    options: {
      type: Object as PropType<ClientUiRenderSlotOptions>,
      default: () => ({}),
    },
  },
  setup(props) {
    const runtime = useClientUiRuntime();
    return () => runtime.renderSlot(props.name, props.owner, props.options);
  },
});

/** 按注册 Token 渲染一个 Entry，并由 Runtime 注入子 Slot 渲染能力。 */
export const ClientUiSlotEntry = defineComponent({
  name: "ClientUiSlotEntry",
  props: {
    entryToken: { type: String, required: true },
    owner: {
      type: Object as PropType<Readonly<Record<string, unknown>>>,
      default: () => ({}),
    },
  },
  setup(props) {
    const runtime = useClientUiRuntime();
    return () => runtime.renderSlotEntry(props.entryToken, props.owner);
  },
});

/** 单个 Slot Entry 的错误边界；崩溃后让出 cell，后备优先级可以接管。 */
export const ClientUiSlotEntryBoundary = defineComponent({
  name: "ClientUiSlotEntryBoundary",
  props: {
    entryToken: { type: String, required: true },
    runtimeId: { type: String, required: true },
  },
  setup(props, { slots }) {
    const runtime = useClientUiRuntime();
    const failed = ref(false);
    onErrorCaptured((error) => {
      failed.value = true;
      runtime.reportSlotRenderFailure(props.entryToken, props.runtimeId, error);
      return false;
    });
    return () => (failed.value ? null : slots.default?.());
  },
});

function projectNavigationPage(entry: RegisteredClientUiSlotEntry): RegisteredNavigationPage {
  const page = entry.options as NavigationPageSlotRegistration;
  return {
    id: page.id,
    path: page.path,
    label: page.label,
    ...(page.description === undefined ? {} : { description: page.description }),
    ...(page.order === undefined ? {} : { order: page.order }),
    ...(page.priority === undefined ? {} : { priority: page.priority }),
    ...(page.icon === undefined ? {} : { icon: page.icon }),
    ...(page.navigation === undefined ? {} : { navigation: page.navigation }),
    ...(page.placement === undefined ? {} : { placement: page.placement }),
    ...(page.settingsGroup === undefined ? {} : { settingsGroup: page.settingsGroup }),
    runtimeId: entry.runtimeId,
    routeName: routeNameForPage(entry.runtimeId, page.id),
    entryToken: entry.token,
    component: entry.component,
  };
}

function projectWorkspaceSidebar(entry: RegisteredClientUiSlotEntry): RegisteredWorkspaceSidebar {
  if (!("key" in entry.options) || typeof entry.options.key !== "string") {
    throw new TypeError("workspace sidebar slot entry has no key");
  }
  return {
    runtimeId: entry.runtimeId,
    workspaceId: entry.options.key,
    entryToken: entry.token,
    component: entry.component,
  };
}

function projectPageRootExtension(entry: RegisteredClientUiSlotEntry): RegisteredPageRootExtension {
  const extension = entry.options as PageRootExtensionSlotRegistration;
  return {
    runtimeId: entry.runtimeId,
    id: extension.id,
    entryToken: entry.token,
    component: entry.component,
    mode: extension.mode ?? "append",
    ...(extension.order === undefined ? {} : { order: extension.order }),
    ...(extension.priority === undefined ? {} : { priority: extension.priority }),
  };
}

function routeNameForPage(runtimeId: string, pageId: string): string {
  return `ui:${runtimeId}:${pageId}`;
}

function fingerprintDescriptor(descriptor: ClientEntryDescriptor): string {
  return JSON.stringify(descriptor);
}

function resolveClientUiModule(value: unknown): ClientUiModule {
  const candidate =
    value && typeof value === "object" && "default" in value
      ? (value as { default: unknown }).default
      : value;
  if (!candidate || typeof candidate !== "object" || !("apply" in candidate)) {
    throw new TypeError("client UI module must export an apply function");
  }
  if (typeof (candidate as { apply?: unknown }).apply !== "function") {
    throw new TypeError("client UI module apply must be a function");
  }
  return candidate as ClientUiModule;
}
