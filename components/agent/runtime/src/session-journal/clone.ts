import { uuidV7 } from "./identifiers";

export function cloneSessionRecords(
  records: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const invocationIds = new Map<string, string>();
  const messageIds = new Map<string, string>();
  const toolCallIds = new Map<string, string>();

  return records.map((record) => {
    if (record.type === "invocation") {
      return {
        ...record,
        id: remapIdentifier(invocationIds, record.id),
        ...(record.contentBlocks === undefined
          ? {}
          : { contentBlocks: remapContentBlockToolCalls(record.contentBlocks, toolCallIds) }),
      };
    }
    if (record.type === "message") {
      return {
        ...record,
        id: remapIdentifier(messageIds, record.id),
        invocationId: remapIdentifier(invocationIds, record.invocationId),
        ...(record.contentBlocks === undefined
          ? {}
          : { contentBlocks: remapContentBlockToolCalls(record.contentBlocks, toolCallIds) }),
        ...(record.providerContent === undefined
          ? {}
          : {
              providerContent: remapProviderContentToolCalls(record.providerContent, toolCallIds),
            }),
      };
    }
    if (record.type === "tool-call") {
      return {
        ...record,
        id: remapIdentifier(toolCallIds, record.id),
        invocationId: remapIdentifier(invocationIds, record.invocationId),
      };
    }
    return { ...record };
  });
}

function remapContentBlockToolCalls(value: unknown, toolCallIds: Map<string, string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const block = entry as Record<string, unknown>;
    return block.type === "tool-call"
      ? { ...block, toolCallId: remapIdentifier(toolCallIds, block.toolCallId) }
      : { ...block };
  });
}

function remapProviderContentToolCalls(value: unknown, toolCallIds: Map<string, string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const block = entry as Record<string, unknown>;
    return block.type === "toolCall"
      ? { ...block, id: remapIdentifier(toolCallIds, block.id) }
      : { ...block };
  });
}

function remapIdentifier(identifiers: Map<string, string>, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const existing = identifiers.get(value);
  if (existing) return existing;
  const id = uuidV7();
  identifiers.set(value, id);
  return id;
}
