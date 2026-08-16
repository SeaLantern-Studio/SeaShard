import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

export const builtInClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.about-ui/about.client": {
    load: () => import("@seashard/about-ui/client"),
  },
  "seashard.runtime-diagnostics/runtime-diagnostics.client": {
    load: () => import("@seashard/runtime-diagnostics/client"),
  },
  "seashard.personalization-ui/personalization.client": {
    load: () => import("@seashard/personalization-ui/client"),
  },
};
