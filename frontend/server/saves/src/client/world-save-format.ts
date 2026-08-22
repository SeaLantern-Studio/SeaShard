import type { ServerWorldDimension } from "@seashard/contracts";

/** 统一存档列表、详情和备份行的时间显示，避免各子组件各自维护格式规则。 */
export function formatWorldSaveDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "—";
}

/** 备份文件大小使用面向用户的二进制单位显示。 */
export function formatWorldSaveSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 把服务端维度标识转换成存档页面使用的中文名称。 */
export function formatWorldSaveDimension(dimension: ServerWorldDimension): string {
  if (dimension === "nether") return "下界";
  if (dimension === "end") return "末地";
  return "主世界";
}
