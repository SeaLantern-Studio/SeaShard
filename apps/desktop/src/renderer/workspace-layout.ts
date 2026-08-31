export type WorkspaceMode = "agent" | "server" | "launcher";
export type SettingsMode = "general" | "agent" | "server";

export type WorkspaceRouteHistory = Record<WorkspaceMode, string>;

/** 各工作区首次进入时使用稳定入口，之后由 Renderer 内存覆盖为最后访问位置。 */
export function createWorkspaceRouteHistory(): WorkspaceRouteHistory {
  return {
    agent: defaultWorkspacePath("agent"),
    server: defaultWorkspacePath("server"),
    launcher: defaultWorkspacePath("launcher"),
  };
}

/** 根据路由前缀识别顶层工作区；设置页不会误写任何工作区的返回位置。 */
export function workspaceForPath(path: string): WorkspaceMode | undefined {
  if (path.startsWith("/server/")) return "server";
  if (path.startsWith("/agent/")) return "agent";
  if (path.startsWith("/launcher/")) return "launcher";
  return undefined;
}

/**
 * Client Entry 停用或升级会同步撤销动态路由。切回工作区前先确认记忆页面仍存在，
 * 已撤销页面回落到内置入口，避免 Router 接受未匹配地址后显示空白内容。
 */
export function resolveWorkspaceRoute(
  history: WorkspaceRouteHistory,
  workspace: WorkspaceMode,
  hasRoute: (path: string) => boolean,
): string | undefined {
  const remembered = history[workspace];
  if (workspace === "launcher" || hasRoute(pathWithoutQueryOrHash(remembered))) return remembered;

  const fallback = defaultWorkspacePath(workspace);
  if (!hasRoute(fallback)) return undefined;
  history[workspace] = fallback;
  return fallback;
}

/**
 * 同时保存 query 与 hash，保证切回工作区时恢复到完全相同的页面位置。
 * 返回所属工作区，供 App 以路由作为当前工作区的唯一事实来源。
 */
export function rememberWorkspaceRoute(
  history: WorkspaceRouteHistory,
  path: string,
  fullPath: string,
): WorkspaceMode | undefined {
  const workspace = workspaceForPath(path);
  if (workspace) history[workspace] = fullPath;
  return workspace;
}

function defaultWorkspacePath(workspace: WorkspaceMode): string {
  if (workspace === "agent") return "/agent/chat";
  if (workspace === "server") return "/server/launch";
  return "/";
}

function pathWithoutQueryOrHash(fullPath: string): string {
  const suffix = fullPath.search(/[?#]/u);
  return suffix < 0 ? fullPath : fullPath.slice(0, suffix);
}
