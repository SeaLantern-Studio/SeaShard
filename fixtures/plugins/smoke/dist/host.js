export const inject = ["seashard.smoke.marker"];
export const provides = ["seashard.smoke.echo"];

export const Config = {
  "~standard": {
    version: 1,
    vendor: "seashard-smoke",
    validate(value) {
      if (!value || typeof value !== "object" || typeof value.marker !== "string") {
        return { issues: [{ message: "marker must be a string" }] };
      }
      return { value };
    },
  },
};

export async function apply(ctx, config) {
  const markerService = ctx.service("seashard.smoke.marker");
  const prefix = await markerService.prefix(config.marker);
  const activation = await ctx.storage.get("smoke/activation");
  const activationCount =
    activation?.value && typeof activation.value === "object"
      ? Number(activation.value.count)
      : 0;
  const savedActivation = await ctx.storage.put(
    "smoke/activation",
    { count: activationCount + 1 },
    { expectedRevision: activation?.revision ?? null },
  );

  ctx.provide("seashard.smoke.echo", {
    echo(value) {
      return `${prefix}:${value}`;
    },
    activationCount() {
      return savedActivation.value.count;
    },
  });
  ctx.contribute("seashard.smoke.contribution", {
    runtimeId: ctx.runtimeId,
    generation: ctx.generation,
  });
  ctx.effect(() => {
    console.log(`SEASHARD_PLUGIN_HOST_ACTIVE runtime=${ctx.runtimeId}`);
    return () => {
      console.log(`SEASHARD_PLUGIN_HOST_DISPOSED runtime=${ctx.runtimeId}`);
    };
  }, "smoke lifecycle resource");
}
