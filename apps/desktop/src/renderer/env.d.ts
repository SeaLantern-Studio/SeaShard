/// <reference types="vite/client" />

import type { SeaShardDesktopApi } from "@seashard/contracts";

declare global {
  interface Window {
    seashard: SeaShardDesktopApi;
  }
}

export {};
