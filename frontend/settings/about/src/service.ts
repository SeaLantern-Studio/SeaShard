import type { DesktopUpdateClientService } from "@seashard/contracts";

export const aboutUiServiceContract = "seashard.ui.about";

/** 关于页只依赖当前壳层投影；Desktop 更新器不会泄漏给 Server Web。 */
export interface AboutUiService {
  readonly target: "desktop" | "server";
  readonly technology: string;
  readonly updates?: DesktopUpdateClientService;
  getCurrentVersion(): Promise<string>;
}
