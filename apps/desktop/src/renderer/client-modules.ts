import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

export const builtInClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.about-ui/about.client": {
    load: () => import("@seashard/about-ui/client"),
  },
  "seashard.runtime-diagnostics-ui/runtime-diagnostics.client": {
    load: () => import("@seashard/runtime-diagnostics-ui/client"),
  },
  "seashard.personalization-ui/personalization.client": {
    load: () => import("@seashard/personalization-ui/client"),
  },
  "seashard.server-download-ui/server-download.client": {
    load: () => import("@seashard/server-download-ui/client"),
  },
  "seashard.server-settings-ui/server-settings.client": {
    load: () => import("@seashard/server-settings-ui/client"),
  },
};
