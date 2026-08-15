export type RuntimePhase = "active" | "updating" | "blocked" | "failed";

export const desktopChannels = {
  runtimeSnapshot: "seashard.runtime.snapshot",
} as const;

export interface ComponentSnapshot {
  id: string;
  displayName: string;
  generation: number;
  phase: RuntimePhase;
  error?: string;
}

export interface RuntimeSnapshot {
  protocolVersion: 1;
  host: "electron";
  state: "active" | "degraded" | "stopping";
  startedAt: string;
  components: ComponentSnapshot[];
}

export interface SeaShardDesktopApi {
  runtime: {
    getSnapshot(): Promise<RuntimeSnapshot>;
  };
}
