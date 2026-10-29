import type { Message } from "../../types/message.js";

const DENSE_MIN_CHARS = 400;
const DENSE_KEEP_HEAD = 80;
const DENSE_KEEP_TAIL = 40;

const BASE64ISH = /[A-Za-z0-9+/]{400,}={0,2}/g;
const DATA_URI = /data:[^;,\s]+;base64,[A-Za-z0-9+/]+=*/g;
const SVG_BLOCK = /<svg[\s\S]{400,}?<\/svg>/gi;

function truncateBlob(blob: string): string {
  if (blob.length < DENSE_MIN_CHARS) {
    return blob;
  }
  return `${blob.slice(0, DENSE_KEEP_HEAD)}…[dense content truncated: ${blob.length} chars]…${blob.slice(-DENSE_KEEP_TAIL)}`;
}

export function stripDensePayloads(text: string): string {
  if (text.length < DENSE_MIN_CHARS) {
    return text;
  }
  let next = text.replace(DATA_URI, (m) => truncateBlob(m));
  next = next.replace(SVG_BLOCK, (m) => truncateBlob(m));
  next = next.replace(BASE64ISH, (m) => truncateBlob(m));
  return next;
}

function rewriteToolResultContent(
  content: unknown
): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    const stripped = stripDensePayloads(content);
    return { content: stripped, changed: stripped !== content };
  }
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }
  let changed = false;
  const next = content.map((item) => {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      const stripped = stripDensePayloads(item.text);
      if (stripped !== item.text) {
        changed = true;
        return { ...item, text: stripped };
      }
    }
    return item;
  });
  return { content: changed ? next : content, changed };
}

/**
 * Drop high-entropy blobs (base64, data URIs, large inline SVG) from tool
 * results so a prompt-too-long compact retry is less likely to fail again.
 * Public 2.1.310 behavior: compaction after PTL was keeping too much dense
 * text. Returns the same array reference when nothing changed.
 */
export function stripDenseTextFromMessages(messages: Message[]): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.type !== "user" || !Array.isArray(message.message.content)) {
      return message;
    }
    let messageChanged = false;
    const newContent = message.message.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }
      const rewritten = rewriteToolResultContent(block.content);
      if (!rewritten.changed) {
        return block;
      }
      messageChanged = true;
      return { ...block, content: rewritten.content };
    });
    if (!messageChanged) {
      return message;
    }
    changed = true;
    return {
      ...message,
      message: { ...message.message, content: newContent },
    } as typeof message;
  });
  return changed ? next : messages;
}
