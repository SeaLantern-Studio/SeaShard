export { default as ApplicationHeader } from "./ApplicationHeader.vue";
export { default as ApplicationSidebar } from "./AppSidebar.vue";
export { default as PageExtensionRoot } from "./PageExtensionRoot.vue";
export { default as UiEntryBoundary } from "./UiEntryBoundary.vue";
export { appearanceService } from "./appearance";
export type { ApplicationHeaderHostIndicator } from "./types";
export {
  createWorkspaceRouteHistory,
  rememberWorkspaceRoute,
  resolveWorkspaceRoute,
  workspaceForPath,
  type SettingsMode,
  type WorkspaceMode,
  type WorkspaceRouteHistory,
} from "./workspace-layout";
