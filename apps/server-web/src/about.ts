import type { AboutUiService } from "@seashard/about-ui";

let controllerVersion = "—";

export const serverAboutUiService: AboutUiService = {
  target: "server",
  technology: "Node.js + Vue 3",
  getCurrentVersion: async () => controllerVersion,
};

/** 鉴权 Bootstrap 和页面 Entry 使用同一份版本投影，避免页面自行读取构建文件。 */
export function acceptServerControllerVersion(version: string): void {
  controllerVersion = version;
}
