import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createNvidiaFetch } from "./nvidia-chat-adapter.js";

const ENV_KEYS = [
  "NVIDIA_TEMPERATURE",
  "NVIDIA_TOP_P",
  "NVIDIA_SEED",
  "NVIDIA_REASONING_EFFORT",
  "NVIDIA_THINKING_MODE",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("NVIDIA request mapping", () => {
  test("maps Anthropic messages and tools to NVIDIA Chat Completions", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> | undefined;
    const nvidiaFetch = createNvidiaFetch(
      "test-nvidia-key",
      async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return chatResponse([
          chatChunk({ content: "done" }),
          chatChunk({}, "stop", { prompt_tokens: 11, completion_tokens: 2 }),
        ]);
      },
      "https://integrate.api.nvidia.com/v1"
    );

    const response = await nvidiaFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "z-ai/glm-5.2",
          system: [{ type: "text", text: "You are a coding agent." }],
          max_tokens: 4096,
          stream: false,
          tools: [
            {
              name: "read_file",
              description: "Read a file",
              input_schema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
          messages: [
            { role: "user", content: "Inspect the repository." },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call_existing",
                  name: "read_file",
                  input: { path: "README.md" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call_existing",
                  content: "Repository docs",
                },
              ],
            },
          ],
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(capturedUrl).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions"
    );
    expect(capturedHeaders.get("Authorization")).toBe("Bearer test-nvidia-key");
    expect(capturedBody).toMatchObject({
      model: "z-ai/glm-5.2",
      stream: true,
      max_tokens: 4096,
      temperature: 1,
      top_p: 1,
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Inspect the repository." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_existing",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_existing",
          content: "Repository docs",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
    });
  });

  test("does not intercept non-Messages SDK requests", async () => {
    let calls = 0;
    const nvidiaFetch = createNvidiaFetch("test-key", async (input) => {
      calls += 1;
      return new Response(String(input));
    });

    const response = await nvidiaFetch("https://api.anthropic.com/v1/models");

    expect(calls).toBe(1);
    expect(await response.text()).toBe("https://api.anthropic.com/v1/models");
  });

  test("clamps output to NVIDIA GLM-5.2 hosted limits", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const nvidiaFetch = createNvidiaFetch("test-key", async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatResponse([chatChunk({ content: "ok" }, "stop")]);
    });

    const response = await nvidiaFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "z-ai/glm-5.2",
          max_tokens: 64_000,
          stream: false,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }
    );
    await response.text();

    expect(capturedBody?.max_tokens).toBe(32_768);
  });

  test.each([
    [
      "deepseek-ai/deepseek-v4-pro",
      {
        max_tokens: 16_384,
        temperature: 1,
        top_p: 0.95,
        reasoning_effort: "max",
      },
    ],
    [
      "deepseek-ai/deepseek-v4-flash",
      {
        max_tokens: 16_384,
        temperature: 1,
        top_p: 0.95,
        reasoning_effort: "max",
      },
    ],
    [
      "minimaxai/minimax-m3",
      {
        max_tokens: 16_384,
        temperature: 1,
        top_p: 0.95,
        chat_template_kwargs: { thinking_mode: "adaptive" },
      },
    ],
  ])("applies the NVIDIA profile for %s", async (model, expected) => {
    let capturedBody: Record<string, unknown> | undefined;
    const nvidiaFetch = createNvidiaFetch("test-key", async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatResponse([chatChunk({ content: "ok" }, "stop")]);
    });

    const response = await nvidiaFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model,
          max_tokens: 24_000,
          stream: false,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }
    );
    await response.text();

    expect(capturedBody).toMatchObject({ model, ...expected });
  });

  test("allows supported reasoning overrides without leaking them to other models", async () => {
    process.env.NVIDIA_REASONING_EFFORT = "none";
    process.env.NVIDIA_THINKING_MODE = "enabled";
    const requests: Array<Record<string, unknown>> = [];
    const nvidiaFetch = createNvidiaFetch("test-key", async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatResponse([chatChunk({ content: "ok" }, "stop")]);
    });

    for (const model of [
      "deepseek-ai/deepseek-v4-pro",
      "minimaxai/minimax-m3",
      "z-ai/glm-5.2",
    ]) {
      const response = await nvidiaFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: "user", content: "Hello" }],
          }),
        }
      );
      await response.text();
    }

    expect(requests[0]?.reasoning_effort).toBe("none");
    expect(requests[0]?.chat_template_kwargs).toBeUndefined();
    expect(requests[1]?.reasoning_effort).toBeUndefined();
    expect(requests[1]?.chat_template_kwargs).toEqual({
      thinking_mode: "enabled",
    });
    expect(requests[2]?.reasoning_effort).toBeUndefined();
    expect(requests[2]?.chat_template_kwargs).toBeUndefined();
  });
});

describe("NVIDIA response mapping", () => {
  test("streams text and tool calls as Anthropic SSE events", async () => {
    const nvidiaFetch = createNvidiaFetch("test-key", async () =>
      chatResponse([
        chatChunk({ reasoning_content: "Check the file. " }),
        chatChunk({ content: "I will inspect it." }),
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_42",
              type: "function",
              function: { name: "read_file", arguments: '{"path":' },
            },
          ],
        }),
        chatChunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: '"README.md"}' },
            },
          ],
        }),
        chatChunk({}, "tool_calls", {
          prompt_tokens: 25,
          completion_tokens: 12,
        }),
      ])
    );

    const response = await nvidiaFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "z-ai/glm-5.2",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "Inspect README.md" }],
        }),
      }
    );
    const body = await response.text();

    expect(body).toContain("event: message_start");
    expect(body).toContain(
      '"delta":{"type":"thinking_delta","thinking":"Check the file. "}'
    );
    expect(body).toContain(
      '"delta":{"type":"text_delta","text":"I will inspect it."}'
    );
    expect(body).toContain(
      '"content_block":{"type":"tool_use","id":"call_42","name":"read_file","input":{}}'
    );
    expect(body).toContain(
      '"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}'
    );
    expect(body).toContain('"stop_reason":"tool_use"');
    expect(body).toContain('"input_tokens":25,"output_tokens":12');
    expect(body).toContain("event: message_stop");
  });

  test("collects a provider stream into an Anthropic JSON message", async () => {
    const nvidiaFetch = createNvidiaFetch("test-key", async () =>
      chatResponse([
        chatChunk({ content: "Complete" }),
        chatChunk({}, "stop", {
          prompt_tokens: 3,
          completion_tokens: 1,
        }),
      ])
    );

    const response = await nvidiaFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "z-ai/glm-5.2",
          max_tokens: 32,
          stream: false,
          messages: [{ role: "user", content: "Finish" }],
        }),
      }
    );

    expect(await response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "z-ai/glm-5.2",
      content: [{ type: "text", text: "Complete" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  test("returns a non-retryable authentication error without a key", async () => {
    const nvidiaFetch = createNvidiaFetch("", async () => {
      throw new Error("Provider should not be called");
    });

    const response = await nvidiaFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          stream: false,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toMatchObject({
      error: {
        type: "authentication_error",
        message: expect.stringContaining("NVIDIA API key is missing"),
      },
    });
  });
});

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, number>
): Record<string, unknown> {
  return {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    model: "z-ai/glm-5.2",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function chatResponse(chunks: Array<Record<string, unknown>>): Response {
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
