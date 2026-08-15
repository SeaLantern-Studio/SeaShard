import type { Plugin } from "cordis";

interface ProbeState {
  activeResources: number;
  ticks: number;
}

const probe: ProbeState = {
  activeResources: 0,
  ticks: 0,
};

export const bootstrapStatusPlugin = {
  name: "seashard.bootstrap-status",
  apply(ctx) {
    ctx.effect(() => {
      probe.activeResources += 1;
      const timer = setInterval(() => {
        probe.ticks += 1;
      }, 250);
      timer.unref();

      return () => {
        clearInterval(timer);
        probe.activeResources -= 1;
      };
    }, "bootstrap status heartbeat");
  },
} satisfies Plugin;

export function getBootstrapProbe(): Readonly<ProbeState> {
  return { ...probe };
}
