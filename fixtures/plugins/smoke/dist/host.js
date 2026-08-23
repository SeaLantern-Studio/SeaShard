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
  ctx.agentResources({
    "smoke://state/{name}": {
      description: "Read the external smoke plugin state.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["plain", "detail"] },
        },
        additionalProperties: false,
      },
      implementation: {
        async read({ pathParams, input }) {
          return {
            mimeType: "text/plain",
            content: `${prefix}:${pathParams.name}:${input.format ?? "plain"}`,
          };
        },
        presentRequest({ pathParams, input }) {
          return [
            { label: "名称", value: pathParams.name },
            { label: "格式", value: input.format ?? "plain" },
          ];
        },
        presentResult() {
          return [{ value: "1", unit: "个状态" }];
        },
      },
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
