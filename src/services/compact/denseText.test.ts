import { expect, test } from "bun:test";
import { stripDensePayloads, stripDenseTextFromMessages } from "./denseText.js";
import type { Message } from "../../types/message.js";

test("stripDensePayloads leaves short text alone", () => {
  expect(stripDensePayloads("hello world")).toBe("hello world");
});

test("stripDensePayloads truncates long base64", () => {
  const blob = "A".repeat(500);
  const out = stripDensePayloads(`prefix ${blob} suffix`);
  expect(out.includes("dense content truncated: 500 chars")).toBe(true);
  expect(out.length).toBeLessThan(blob.length);
});

test("stripDenseTextFromMessages rewrites tool_result blobs and leaves other messages", () => {
  const blob = "B".repeat(500);
  const messages = [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }] },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: `data: ${blob}` },
        ],
      },
    },
  ] as unknown as Message[];
  const out = stripDenseTextFromMessages(messages);
  expect(out).not.toBe(messages);
  const block = (out[1] as { message: { content: Array<{ content: string }> } })
    .message.content[0];
  expect(block.content.includes("dense content truncated")).toBe(true);
});
