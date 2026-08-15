import type { ComponentSnapshot, RuntimePhase, RuntimeSnapshot } from "@seashard/contracts";
import type { Context, Fiber, Plugin } from "cordis";

export interface ComponentDescriptor<T = unknown> {
  id: string;
  displayName: string;
  plugin: Plugin<T>;
  config?: T;
}

interface RuntimeUnit {
  descriptor: ComponentDescriptor<unknown>;
  generation: number;
  phase: RuntimePhase;
  fiber?: Fiber;
  error?: string;
}

export class ComponentSupervisor {
  readonly startedAt = new Date().toISOString();

  private readonly units = new Map<string, RuntimeUnit>();
  private stopping = false;
  private disposeTask?: Promise<void>;

  constructor(private readonly root: Context) {}

  async start<T>(descriptor: ComponentDescriptor<T>): Promise<void> {
    if (this.stopping) {
      throw new Error("component supervisor is stopping");
    }
    if (this.units.has(descriptor.id)) {
      throw new Error(`component already registered: ${descriptor.id}`);
    }

    const unit: RuntimeUnit = {
      descriptor: descriptor as ComponentDescriptor<unknown>,
      generation: 1,
      phase: "discovered",
    };
    this.units.set(descriptor.id, unit);
    unit.phase = "starting";

    try {
      const fiber = this.root.plugin(descriptor.plugin, descriptor.config as T);
      unit.fiber = fiber;
      await fiber;
      unit.phase = "active";
    } catch (error) {
      unit.phase = "failed";
      unit.error = formatError(error);
      throw error;
    }
  }

  snapshot(): RuntimeSnapshot {
    const components = [...this.units.values()].map<ComponentSnapshot>((unit) => ({
      id: unit.descriptor.id,
      displayName: unit.descriptor.displayName,
      generation: unit.generation,
      phase: unit.phase,
      ...(unit.error ? { error: unit.error } : {}),
    }));

    return {
      protocolVersion: 1,
      host: "electron",
      state: this.stopping
        ? "stopping"
        : components.some((component) => component.phase === "failed")
          ? "degraded"
          : "active",
      startedAt: this.startedAt,
      components,
    };
  }

  async stop(id: string): Promise<void> {
    const unit = this.units.get(id);
    if (!unit || unit.phase === "disabled") return;

    unit.phase = "quiescing";
    unit.phase = "stopping";
    await unit.fiber?.dispose();
    unit.fiber = undefined;
    unit.phase = "disabled";
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeUnits();
    return this.disposeTask;
  }

  private async disposeUnits(): Promise<void> {
    this.stopping = true;
    const ids = [...this.units.keys()].reverse();
    for (const id of ids) {
      await this.stop(id);
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
