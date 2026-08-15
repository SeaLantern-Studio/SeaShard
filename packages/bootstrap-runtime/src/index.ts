import { Context, type Fiber } from "cordis";

export type BootstrapDisposer = () => void | Promise<void>;

export interface BootstrapDescriptor {
  readonly id: string;
  readonly buildDigest: string;
  readonly inject: readonly string[];
  readonly provides: readonly string[];
  load(ctx: Context): void | BootstrapDisposer | Promise<void | BootstrapDisposer>;
}

export interface LoadedBootstrapComponent {
  readonly id: string;
  readonly buildDigest: string;
  readonly provides: readonly string[];
}

const componentIdPattern = /^[a-z][a-z0-9.-]{0,126}$/;
const contractPattern = /^[a-z][a-z0-9.*:-]{0,126}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export class BootstrapLoader {
  private readonly fibers: Fiber[] = [];
  private readonly loadedComponents: LoadedBootstrapComponent[] = [];
  private started = false;
  private disposeTask?: Promise<void>;

  constructor(readonly root: Context) {}

  async start(descriptors: readonly BootstrapDescriptor[]): Promise<void> {
    if (this.started) throw new Error("bootstrap loader has already started");
    this.started = true;
    const ordered = orderDescriptors(descriptors);
    try {
      for (const descriptor of ordered) {
        const adapter = {
          name: descriptor.id,
          apply: async (ctx: Context) => {
            const dispose = await descriptor.load(ctx);
            if (dispose) ctx.effect(() => dispose, `bootstrap component ${descriptor.id}`);
          },
        };
        const fiber = this.root.plugin(adapter);
        this.fibers.push(fiber);
        await fiber;
        this.loadedComponents.push({
          id: descriptor.id,
          buildDigest: descriptor.buildDigest,
          provides: [...descriptor.provides],
        });
      }
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  snapshot(): readonly LoadedBootstrapComponent[] {
    return this.loadedComponents.map((component) => ({
      ...component,
      provides: [...component.provides],
    }));
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeFibers();
    return this.disposeTask;
  }

  private async disposeFibers(): Promise<void> {
    const failures: unknown[] = [];
    for (const fiber of this.fibers.reverse()) {
      try {
        await fiber.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.fibers.length = 0;
    this.loadedComponents.length = 0;
    if (failures.length) throw new AggregateError(failures, "bootstrap component disposal failed");
  }
}

export function orderDescriptors(
  descriptors: readonly BootstrapDescriptor[],
): readonly BootstrapDescriptor[] {
  const components = new Map<string, BootstrapDescriptor>();
  const providers = new Map<string, string>();
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor);
    if (components.has(descriptor.id))
      throw new Error(`duplicate bootstrap component: ${descriptor.id}`);
    components.set(descriptor.id, descriptor);
    for (const contract of descriptor.provides) {
      const existing = providers.get(contract);
      if (existing) {
        throw new Error(
          `bootstrap contract ${contract} is provided by both ${existing} and ${descriptor.id}`,
        );
      }
      providers.set(contract, descriptor.id);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const descriptor of descriptors) {
    const required = new Set<string>();
    for (const contract of descriptor.inject) {
      const provider = providers.get(contract);
      if (!provider) {
        throw new Error(`bootstrap component ${descriptor.id} requires missing ${contract}`);
      }
      if (provider === descriptor.id) {
        throw new Error(`bootstrap component ${descriptor.id} cannot inject its own ${contract}`);
      }
      required.add(provider);
    }
    dependencies.set(descriptor.id, required);
  }

  const ordered: BootstrapDescriptor[] = [];
  const remaining = new Map(dependencies);
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, required]) => [...required].every((id) => !remaining.has(id)))
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right));
    if (!ready.length) {
      throw new Error(`bootstrap dependency cycle: ${[...remaining.keys()].sort().join(", ")}`);
    }
    for (const id of ready) {
      ordered.push(components.get(id)!);
      remaining.delete(id);
    }
  }
  return ordered;
}

function validateDescriptor(descriptor: BootstrapDescriptor): void {
  if (!componentIdPattern.test(descriptor.id)) {
    throw new TypeError(`invalid bootstrap component id: ${descriptor.id}`);
  }
  if (!digestPattern.test(descriptor.buildDigest)) {
    throw new TypeError(`invalid bootstrap build digest for ${descriptor.id}`);
  }
  for (const [kind, contracts] of [
    ["inject", descriptor.inject],
    ["provides", descriptor.provides],
  ] as const) {
    const unique = new Set<string>();
    for (const contract of contracts) {
      if (!contractPattern.test(contract)) {
        throw new TypeError(`invalid bootstrap ${kind} contract: ${contract}`);
      }
      if (unique.has(contract)) {
        throw new TypeError(`duplicate bootstrap ${kind} contract: ${contract}`);
      }
      unique.add(contract);
    }
  }
}
