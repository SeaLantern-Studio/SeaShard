import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

export const builtInClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.runtime-diagnostics/runtime-diagnostics.client": {
    load: () => import("@seashard/runtime-diagnostics/client"),
  },
};
