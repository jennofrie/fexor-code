/**
 * NVIDIA NIM Chat Completions adapter.
 *
 * Fexor speaks Anthropic Messages internally, while NVIDIA's hosted free
 * endpoint exposes GLM through OpenAI-compatible Chat Completions. This fetch
 * interceptor translates requests and streams back into Anthropic events.
 */

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface ChatToolState {
  index: number;
  id: string;
  name: string;
  arguments: string;
  blockIndex: number | null;
  closed: boolean;
}

interface ParsedChatStream {
  content: Array<Record<string, unknown>>;
  inputTokens: number;
  outputTokens: number;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

const DEFAULT_NVIDIA_BASE_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_NVIDIA_MODEL = "z-ai/glm-5.2";

interface NvidiaModelProfile {
  defaultMaxTokens: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  reasoningEffort?: "none" | "high" | "max";
  thinkingMode?: "disabled" | "enabled" | "adaptive";
}

const DEFAULT_NVIDIA_PROFILE: NvidiaModelProfile = {
  defaultMaxTokens: 16_384,
  maxTokens: 16_384,
  temperature: 1,
  topP: 0.95,
};

const NVIDIA_MODEL_PROFILES: Record<string, NvidiaModelProfile> = {
  "z-ai/glm-5.2": {
    defaultMaxTokens: 16_384,
    maxTokens: 32_768,
    temperature: 1,
    topP: 1,
  },
  "deepseek-ai/deepseek-v4-pro": {
    defaultMaxTokens: 16_384,
    maxTokens: 16_384,
    temperature: 1,
    topP: 0.95,
    reasoningEffort: "max",
  },
  "deepseek-ai/deepseek-v4-flash": {
    defaultMaxTokens: 16_384,
    maxTokens: 16_384,
    temperature: 1,
    topP: 0.95,
    reasoningEffort: "max",
  },
  "minimaxai/minimax-m3": {
    defaultMaxTokens: 16_384,
    maxTokens: 16_384,
    temperature: 1,
    topP: 0.95,
    thinkingMode: "adaptive",
  },
};

function modelProfile(model: string): NvidiaModelProfile {
  return NVIDIA_MODEL_PROFILES[model.toLowerCase()] ?? DEFAULT_NVIDIA_PROFILE;
}

function shouldInterceptMessagesUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/v1/messages");
  } catch {
    return url.endsWith("/v1/messages");
  }
}

function normalizeChatCompletionsUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (/\/v1\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/?$/i, "/chat/completions");
    }
    return url.toString();
  } catch {
    return /\/v1\/?$/i.test(baseUrl)
      ? baseUrl.replace(/\/?$/i, "/chat/completions")
      : baseUrl;
  }
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n");
}

function toolResultText(block: AnthropicContentBlock): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((item) => {
      if (item.type === "text") return item.text ?? "";
      if (item.type === "image") return "[Image data attached]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function userContent(
  blocks: AnthropicContentBlock[]
): string | Array<Record<string, unknown>> {
  const content = blocks.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }
    if (
      block.type === "image" &&
      block.source?.type === "base64" &&
      block.source.media_type &&
      block.source.data
    ) {
      return [
        {
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        },
      ];
    }
    return [];
  });

  if (content.length === 1 && content[0]?.type === "text") {
    return String(content[0].text);
  }
  return content;
}

function translateMessages(
  messages: AnthropicMessage[],
  system: unknown
): Array<Record<string, unknown>> {
  const translated: Array<Record<string, unknown>> = [];
  const instructions = systemText(system);
  if (instructions) translated.push({ role: "system", content: instructions });

  for (const message of messages) {
    if (typeof message.content === "string") {
      translated.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    if (message.role === "assistant") {
      const text = message.content
        .filter(
          (block) => block.type === "text" && typeof block.text === "string"
        )
        .map((block) => block.text)
        .join("\n");
      const toolCalls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block, index) => ({
          id: block.id || `call_${index}`,
          type: "function",
          function: {
            name: block.name || "",
            arguments: JSON.stringify(block.input || {}),
          },
        }));
      translated.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    let pendingUserBlocks: AnthropicContentBlock[] = [];
    const flushUserBlocks = () => {
      if (pendingUserBlocks.length === 0) return;
      translated.push({
        role: "user",
        content: userContent(pendingUserBlocks),
      });
      pendingUserBlocks = [];
    };

    for (const block of message.content) {
      if (block.type === "tool_result") {
        flushUserBlocks();
        translated.push({
          role: "tool",
          tool_call_id: block.tool_use_id || "",
          content: toolResultText(block),
        });
      } else {
        pendingUserBlocks.push(block);
      }
    }
    flushUserBlocks();
  }

  return translated;
}

function translateToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object") return "auto";
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return "auto";
}

function boundedEnvNumber(
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function envEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = process.env[name];
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function translateRequest(body: Record<string, unknown>): {
  model: string;
  isStreaming: boolean;
  chatBody: Record<string, unknown>;
} {
  const model =
    typeof body.model === "string" && body.model
      ? body.model
      : DEFAULT_NVIDIA_MODEL;
  const profile = modelProfile(model);
  const tools = (body.tools || []) as AnthropicTool[];
  const requestedMaxTokens =
    typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? Math.max(1, Math.floor(body.max_tokens))
      : profile.defaultMaxTokens;
  const maxTokens = Math.min(requestedMaxTokens, profile.maxTokens);
  const temperature =
    boundedEnvNumber("NVIDIA_TEMPERATURE", 0, 1) ?? profile.temperature;
  const topP = boundedEnvNumber("NVIDIA_TOP_P", 0, 1) ?? profile.topP;
  const seed = boundedEnvNumber("NVIDIA_SEED", 0, Number.MAX_SAFE_INTEGER);
  const reasoningEffort = profile.reasoningEffort
    ? envEnum(
        "NVIDIA_REASONING_EFFORT",
        ["none", "high", "max"] as const,
        profile.reasoningEffort
      )
    : undefined;
  const thinkingMode = profile.thinkingMode
    ? envEnum(
        "NVIDIA_THINKING_MODE",
        ["disabled", "enabled", "adaptive"] as const,
        profile.thinkingMode
      )
    : undefined;

  return {
    model,
    isStreaming: body.stream === true,
    chatBody: {
      model,
      messages: translateMessages(
        (body.messages || []) as AnthropicMessage[],
        body.system
      ),
      stream: true,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      tool_choice: translateToolChoice(body.tool_choice),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(thinkingMode
        ? { chat_template_kwargs: { thinking_mode: thinkingMode } }
        : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description || "",
                parameters: tool.input_schema || {
                  type: "object",
                  properties: {},
                },
              },
            })),
          }),
    },
  };
}

function formatSSE(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readChatSSE(
  response: Response,
  onChunk: (chunk: Record<string, unknown>) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("NVIDIA response did not include a body");

  const decoder = new TextDecoder();
  let buffer = "";
  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.error) {
      const error = parsed.error as Record<string, unknown>;
      throw new Error(
        typeof error.message === "string"
          ? error.message
          : "NVIDIA stream returned an error"
      );
    }
    onChunk(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  }
  if (buffer) processLine(buffer);
}

function chatDelta(chunk: Record<string, unknown>): {
  delta: Record<string, unknown>;
  finishReason: unknown;
} {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice =
    choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>)
      : {};
  const delta =
    choice.delta && typeof choice.delta === "object"
      ? (choice.delta as Record<string, unknown>)
      : {};
  return { delta, finishReason: choice.finish_reason };
}

function tokenUsage(chunk: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const usage =
    chunk.usage && typeof chunk.usage === "object"
      ? (chunk.usage as Record<string, unknown>)
      : {};
  return {
    inputTokens:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined,
  };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function translateChatStream(
  response: Response,
  model: string,
  asStream: boolean
): Promise<Response> {
  const messageId = `msg_nvidia_${Date.now()}`;
  const encoder = new TextEncoder();

  if (!asStream) {
    const parsed = await collectChatStream(response);
    return new Response(
      JSON.stringify({
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: parsed.content,
        stop_reason: parsed.stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: parsed.inputTokens,
          output_tokens: parsed.outputTokens,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": messageId,
        },
      }
    );
  }

  const readable = new ReadableStream({
    async start(controller) {
      let nextBlockIndex = 0;
      let activeTextIndex: number | null = null;
      let activeThinkingIndex: number | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
      const tools = new Map<number, ChatToolState>();

      const emit = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(formatSSE(event, data)));
      };
      const closeText = () => {
        if (activeTextIndex === null) return;
        emit("content_block_stop", {
          type: "content_block_stop",
          index: activeTextIndex,
        });
        activeTextIndex = null;
      };
      const closeThinking = () => {
        if (activeThinkingIndex === null) return;
        emit("content_block_stop", {
          type: "content_block_stop",
          index: activeThinkingIndex,
        });
        activeThinkingIndex = null;
      };
      const textIndex = () => {
        if (activeTextIndex !== null) return activeTextIndex;
        closeThinking();
        activeTextIndex = nextBlockIndex++;
        emit("content_block_start", {
          type: "content_block_start",
          index: activeTextIndex,
          content_block: { type: "text", text: "" },
        });
        return activeTextIndex;
      };
      const thinkingIndex = () => {
        if (activeThinkingIndex !== null) return activeThinkingIndex;
        closeText();
        activeThinkingIndex = nextBlockIndex++;
        emit("content_block_start", {
          type: "content_block_start",
          index: activeThinkingIndex,
          content_block: { type: "thinking", thinking: "" },
        });
        return activeThinkingIndex;
      };
      const startTool = (state: ChatToolState) => {
        if (state.blockIndex !== null) return state.blockIndex;
        closeText();
        closeThinking();
        state.blockIndex = nextBlockIndex++;
        emit("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: {
            type: "tool_use",
            id: state.id,
            name: state.name,
            input: {},
          },
        });
        return state.blockIndex;
      };

      emit("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      emit("ping", { type: "ping" });

      try {
        await readChatSSE(response, (chunk) => {
          const { inputTokens: input, outputTokens: output } =
            tokenUsage(chunk);
          if (input !== undefined) inputTokens = input;
          if (output !== undefined) outputTokens = output;

          const { delta, finishReason } = chatDelta(chunk);
          const reasoning =
            typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string"
                ? delta.reasoning
                : "";
          if (reasoning) {
            emit("content_block_delta", {
              type: "content_block_delta",
              index: thinkingIndex(),
              delta: { type: "thinking_delta", thinking: reasoning },
            });
          }

          if (typeof delta.content === "string" && delta.content) {
            emit("content_block_delta", {
              type: "content_block_delta",
              index: textIndex(),
              delta: { type: "text_delta", text: delta.content },
            });
          }

          const toolCalls = Array.isArray(delta.tool_calls)
            ? delta.tool_calls
            : [];
          for (const rawCall of toolCalls) {
            if (!rawCall || typeof rawCall !== "object") continue;
            const call = rawCall as Record<string, unknown>;
            const toolIndex =
              typeof call.index === "number" ? call.index : tools.size;
            const fn =
              call.function && typeof call.function === "object"
                ? (call.function as Record<string, unknown>)
                : {};
            let state = tools.get(toolIndex);
            if (!state) {
              state = {
                index: toolIndex,
                id:
                  typeof call.id === "string"
                    ? call.id
                    : `toolu_nvidia_${toolIndex}`,
                name: typeof fn.name === "string" ? fn.name : "",
                arguments: "",
                blockIndex: null,
                closed: false,
              };
              tools.set(toolIndex, state);
            }
            if (typeof call.id === "string") state.id = call.id;
            if (typeof fn.name === "string") state.name = fn.name;
            const args = typeof fn.arguments === "string" ? fn.arguments : "";
            if (state.name || args) {
              const index = startTool(state);
              if (args) {
                state.arguments += args;
                emit("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "input_json_delta", partial_json: args },
                });
              }
            }
          }

          if (finishReason === "tool_calls") stopReason = "tool_use";
          if (finishReason === "length") stopReason = "max_tokens";
        });
      } catch (error) {
        emit("error", {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        controller.close();
        return;
      }

      closeText();
      closeThinking();
      for (const state of tools.values()) {
        if (state.blockIndex === null) startTool(state);
        if (state.closed || state.blockIndex === null) continue;
        emit("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        });
        state.closed = true;
      }
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      emit("message_stop", {
        type: "message_stop",
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
      controller.close();
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-request-id": messageId,
    },
  });
}

async function collectChatStream(
  response: Response
): Promise<ParsedChatStream> {
  let text = "";
  let reasoning = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: ParsedChatStream["stopReason"] = "end_turn";
  const tools = new Map<number, ChatToolState>();

  await readChatSSE(response, (chunk) => {
    const usage = tokenUsage(chunk);
    inputTokens = usage.inputTokens ?? inputTokens;
    outputTokens = usage.outputTokens ?? outputTokens;
    const { delta, finishReason } = chatDelta(chunk);
    if (typeof delta.content === "string") text += delta.content;
    if (typeof delta.reasoning_content === "string") {
      reasoning += delta.reasoning_content;
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as Record<string, unknown>;
      const index = typeof call.index === "number" ? call.index : tools.size;
      const fn =
        call.function && typeof call.function === "object"
          ? (call.function as Record<string, unknown>)
          : {};
      const state = tools.get(index) || {
        index,
        id: typeof call.id === "string" ? call.id : `toolu_nvidia_${index}`,
        name: "",
        arguments: "",
        blockIndex: null,
        closed: false,
      };
      if (typeof call.id === "string") state.id = call.id;
      if (typeof fn.name === "string") state.name = fn.name;
      if (typeof fn.arguments === "string") state.arguments += fn.arguments;
      tools.set(index, state);
    }
    if (finishReason === "tool_calls") stopReason = "tool_use";
    if (finishReason === "length") stopReason = "max_tokens";
  });

  const content: Array<Record<string, unknown>> = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (text) content.push({ type: "text", text });
  for (const state of tools.values()) {
    content.push({
      type: "tool_use",
      id: state.id,
      name: state.name,
      input: parseArguments(state.arguments),
    });
  }
  return { content, inputTokens, outputTokens, stopReason };
}

function errorResponse(
  message: string,
  status: number,
  stream: boolean
): Response {
  const body = {
    type: "error",
    error: {
      type: status === 401 ? "authentication_error" : "api_error",
      message,
    },
  };
  return new Response(
    stream ? formatSSE("error", body) : JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": stream ? "text/event-stream" : "application/json",
        ...(status === 401 ? { "x-should-retry": "false" } : {}),
      },
    }
  );
}

export function createNvidiaFetch(
  apiKey: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  baseUrl: string = DEFAULT_NVIDIA_BASE_URL
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const endpoint = normalizeChatCompletionsUrl(baseUrl);

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!shouldInterceptMessagesUrl(url)) return baseFetch(input, init);

    let body: Record<string, unknown>;
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === "string"
            ? init.body
            : "{}";
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const { model, isStreaming, chatBody } = translateRequest(body);
    if (!apiKey) {
      return errorResponse(
        "NVIDIA API key is missing. Store it in the nvidia_api_key Keychain service or set NVIDIA_API_KEY.",
        401,
        isStreaming
      );
    }

    const response = await baseFetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(chatBody),
      signal: init?.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 2_000);
      return errorResponse(
        `NVIDIA API error (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
        isStreaming
      );
    }

    try {
      return await translateChatStream(response, model, isStreaming);
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : String(error),
        500,
        isStreaming
      );
    }
  };
}
