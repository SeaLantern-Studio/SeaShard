export const agentTodoStatuses = ["pending", "in_progress", "completed"] as const;
export type AgentTodoStatus = (typeof agentTodoStatuses)[number];

export interface AgentTodoItem {
  readonly content: string;
  readonly status: AgentTodoStatus;
}

/** 当前 Invocation 的完整任务清单；每次 todo 调用都用新快照原子替换。 */
export interface AgentTodoSnapshot {
  readonly items: readonly AgentTodoItem[];
  readonly updatedAt: string;
}
