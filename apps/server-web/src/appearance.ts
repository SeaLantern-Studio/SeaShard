import { createAppearanceService } from "@seashard/application-shell/appearance-core";
import type { ServerWebAppearanceSettings } from "@seashard/server-web-api";
import type { UiAppearanceSettings } from "@seashard/ui-sdk";
import { loadServerAppearance, updateServerAppearance } from "./client-runtime";

type PersistenceErrorListener = (error: unknown) => void;
const persistenceErrorListeners = new Set<PersistenceErrorListener>();

/** Server Web 从创建开始禁用窗口材质，并把每次字段更新顺序写入 Server SQLite。 */
export const serverAppearanceService = createAppearanceService({
  supportsAcrylic: false,
  persist: async (patch) => {
    await updateServerAppearance(projectServerPatch(patch));
  },
  onPersistenceError(error) {
    for (const listener of persistenceErrorListeners) listener(error);
  },
});

export async function hydrateServerAppearance(): Promise<void> {
  const snapshot = await loadServerAppearance();
  serverAppearanceService.replace({
    ...snapshot.settings,
    acrylicEnabled: false,
    acrylicBlurLevel: "off",
  });
}

export function onServerAppearancePersistenceError(listener: PersistenceErrorListener): () => void {
  persistenceErrorListeners.add(listener);
  return () => persistenceErrorListeners.delete(listener);
}

function projectServerPatch(
  patch: Readonly<Partial<UiAppearanceSettings>>,
): Partial<ServerWebAppearanceSettings> {
  const {
    acrylicEnabled: _acrylicEnabled,
    acrylicBlurLevel: _acrylicBlurLevel,
    ...serverPatch
  } = patch;
  return serverPatch;
}
