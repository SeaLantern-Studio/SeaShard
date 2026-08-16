import type { BootstrapDescriptor } from "@seashard/bootstrap-runtime";
import type { DatabaseService } from "@seashard/database";
import { PluginStore } from "@seashard/plugin-system";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";

export interface PluginSystemFoundationBootstrapOptions {
  readonly seaShardVersion: string;
}

export class PluginSystemFoundationService extends Service {
  constructor(
    ctx: Context,
    readonly store: PluginStore,
  ) {
    super(ctx, "plugin-system-foundation");
  }
}

declare module "cordis" {
  interface Context {
    "plugin-system-foundation": PluginSystemFoundationService;
  }
}

export function createPluginSystemFoundationBootstrapDescriptor(
  options: PluginSystemFoundationBootstrapOptions,
): BootstrapDescriptor {
  return {
    id: "seashard.plugin-system-foundation",
    buildDigest: createHash("sha256")
      .update("seashard.plugin-system-foundation.bootstrap.v1")
      .digest("hex"),
    inject: ["database"],
    provides: ["plugin-system-foundation"],
    async load(ctx) {
      const database = requireDatabase(ctx);

      const store = await PluginStore.create(database, options.seaShardVersion);
      await store.interruptRuntimeOperations();
      await store.invalidateRuntimePublications();
      new PluginSystemFoundationService(ctx, store);
    },
  };
}

function requireDatabase(ctx: Context): DatabaseService {
  const candidate: unknown = Reflect.get(ctx, "database");
  if (!isDatabaseService(candidate)) {
    throw new Error("plugin system foundation requires the database service");
  }
  return candidate;
}

function isDatabaseService(value: unknown): value is DatabaseService {
  if (!value || typeof value !== "object") return false;
  return ["registerCapsule", "quickCheck", "checkpoint", "backup", "diagnostics", "close"].every(
    (member) => member in value && typeof Reflect.get(value, member) === "function",
  );
}
