import type { ClientEntryDescriptor, ClientEntryPublication } from "@seashard/contracts";
import type { Disposable } from "@seashard/plugin-sdk";
import type { ClientUiContext, ClientUiModule, NavigationPageContribution } from "@seashard/ui-sdk";
import {
  computed,
  effectScope,
  inject,
  markRaw,
  shallowRef,
  type ComputedRef,
  type EffectScope,
  type InjectionKey,
} from "vue";
import type { Router } from "vue-router";

export interface ClientUiModuleLoader {
  load(): Promise<unknown>;
}

export interface ClientUiRuntimeOptions {
  router: Router;
  loaders: Readonly<Record<string, ClientUiModuleLoader>>;
  services: Readonly<Record<string, object>>;
}

export interface RegisteredNavigationPage extends NavigationPageContribution {
  runtimeId: string;
  routeName: string;
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
  disposers: Disposable[];
}

const contributionIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;

/**
 * 每个 Renderer 独立拥有的轻量 UI Runtime。
 *
 * Main 只发布期望 Entry；该 Runtime 负责本地 Vue Scope、页面注册、渐进故障和清理。
 */
export class ClientUiRuntime {
  readonly ready = shallowRef(false);
  readonly pages: ComputedRef<readonly RegisteredNavigationPage[]>;
  readonly failures: ComputedRef<readonly ClientUiFailure[]>;

  private readonly active = new Map<string, ActiveClientEntry>();
  private readonly pagesById = new Map<string, RegisteredNavigationPage>();
  private readonly pageIdsByPath = new Map<string, string>();
  private readonly pageVersion = shallowRef(0);
  private readonly failuresByRuntime = new Map<string, ClientUiFailure>();
  private readonly failureVersion = shallowRef(0);
  private reconcileQueue: Promise<void> = Promise.resolve();
  private revision = -1;

  constructor(private readonly options: ClientUiRuntimeOptions) {
    this.pages = computed(() => {
      void this.pageVersion.value;
      return [...this.pagesById.values()].sort(
        (left, right) =>
          (left.order ?? 0) - (right.order ?? 0) || left.label.localeCompare(right.label),
      );
    });
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
    const loader = this.options.loaders[descriptor.moduleKey];
    if (!loader) {
      this.recordFailure(
        descriptor.runtimeId,
        "activation",
        new Error(`client module loader is unavailable: ${descriptor.moduleKey}`),
      );
      return;
    }

    const scope = effectScope(true);
    const disposers: Disposable[] = [];
    const record: ActiveClientEntry = {
      descriptor,
      fingerprint: fingerprintDescriptor(descriptor),
      scope,
      disposers,
    };

    try {
      const module = resolveClientUiModule(await loader.load());
      const context: ClientUiContext = {
        entry: descriptor,
        service: <T extends object>(contract: string): T => {
          const service = this.options.services[contract];
          if (!service) throw new Error(`client service is unavailable: ${contract}`);
          return service as T;
        },
        effect: (setup) => {
          const cleanup = setup();
          if (cleanup) disposers.push(cleanup);
        },
        contribute: (kind, value) => {
          if (kind !== "navigation.page") {
            throw new Error("unsupported client UI contribution");
          }
          const page = value as NavigationPageContribution;
          disposers.push(this.registerPage(descriptor.runtimeId, page));
          return `${descriptor.runtimeId}:${kind}:${page.id}`;
        },
      };

      const cleanup = await scope.run(() => module.apply(context, descriptor.config));
      if (cleanup) disposers.push(cleanup);
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

  private registerPage(runtimeId: string, contribution: NavigationPageContribution): Disposable {
    if (!contributionIdPattern.test(contribution.id)) {
      throw new TypeError(`invalid navigation page id: ${contribution.id}`);
    }
    if (!contribution.path.startsWith("/") || contribution.path === "/") {
      throw new TypeError(
        `navigation page path must be a non-root absolute path: ${contribution.path}`,
      );
    }
    const existingId = this.pagesById.get(contribution.id);
    if (existingId) throw new Error(`navigation page id is already registered: ${contribution.id}`);
    const existingPath = this.pageIdsByPath.get(contribution.path);
    if (existingPath) {
      throw new Error(
        `navigation page path is already registered: ${contribution.path} by ${existingPath}`,
      );
    }

    const routeName = `ui:${runtimeId}:${contribution.id}`;
    const page: RegisteredNavigationPage = {
      ...contribution,
      component: markRaw(contribution.component),
      runtimeId,
      routeName,
    };
    const removeRoute = this.options.router.addRoute({
      name: routeName,
      path: contribution.path,
      component: page.component,
      meta: { runtimeId, pageId: contribution.id },
    });
    this.pagesById.set(contribution.id, page);
    this.pageIdsByPath.set(contribution.path, contribution.id);
    this.pageVersion.value += 1;

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      removeRoute();
      if (this.pagesById.get(contribution.id)?.runtimeId === runtimeId) {
        this.pagesById.delete(contribution.id);
        this.pageIdsByPath.delete(contribution.path);
        this.pageVersion.value += 1;
      }
    };
  }

  private async stopEntry(record: ActiveClientEntry): Promise<void> {
    const failures: unknown[] = [];
    for (const dispose of record.disposers.reverse()) {
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
