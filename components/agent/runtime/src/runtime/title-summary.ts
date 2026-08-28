export type ConversationTitleSummarySource = "user-question" | "assistant-answer";

const maximumConversationTitleCharacters = 48;

/**
 * 标题更新间隔由 Session ID 和周期稳定计算为 3～5 轮；重启后无需额外游标，
 * 同一对话仍会落在相同轮次，避免随机数让更新时机漂移。
 */
export function shouldRefreshConversationTitle(sessionId: string, turnNumber: number): boolean {
  if (!Number.isSafeInteger(turnNumber) || turnNumber <= 1) return false;
  let scheduledTurn = 1;
  for (let cycle = 0; scheduledTurn < turnNumber; cycle += 1) {
    scheduledTurn += conversationTitleInterval(sessionId, cycle);
  }
  return scheduledTurn === turnNumber;
}

export function createConversationTitlePrompt(
  source: ConversationTitleSummarySource,
  content: string,
): string {
  const label = source === "user-question" ? "用户问题" : "AI 回答";
  return [
    "你是对话标题生成器。只根据下方提供的一条内容生成能够概括主题的简短摘要，用作对话标题。",
    "要求：",
    `- 摘要依据只能是这条${label}，不得补充其他对话内容；`,
    "- 保留最关键的对象、动作或问题；",
    "- 使用与原内容相同的主要语言；",
    "- 直接输出标题，不要解释，不要使用引号、Markdown 或句末标点；",
    "- 控制在 6～30 个字符或相近长度。",
    "",
    `【${label}开始】`,
    content,
    `【${label}结束】`,
  ].join("\n");
}

export function normalizeConversationTitle(value: string): string | undefined {
  let normalized = value.replace(/\s+/gu, " ").trim();
  normalized = normalized.replace(/^[#*`]+/u, "").trim();
  normalized = normalized.replace(/^(?:标题|摘要)\s*[:：]\s*/u, "");
  normalized = normalized.replace(/^[*`'"“”‘’「」『』]+|[*`'"“”‘’「」『』]+$/gu, "").trim();
  normalized = normalized.replace(/[。！？!?；;：:]+$/gu, "").trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, maximumConversationTitleCharacters).join("");
}

function conversationTitleInterval(sessionId: string, cycle: number): number {
  const input = `${sessionId}:${cycle}`;
  let hash = 2_166_136_261;
  for (const character of input) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return 3 + ((hash >>> 0) % 3);
}
