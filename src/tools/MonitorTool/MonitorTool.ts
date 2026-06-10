// Monitor tool (feature MONITOR_TOOL).
//
// Starts a background monitor: a shell command/script whose stdout is an event
// stream. Each stdout line becomes a notification delivered to the model
// mid-conversation. The script exiting ends the watch; non-persistent monitors
// are killed at the timeout deadline. Use this for "tell me every time X
// happens" (tail -f | grep, inotifywait -m, poll loops) — for a single
// completion signal, use Bash with run_in_background instead.
//
// The tool is a thin launcher: it registers a `monitor_mcp` background task
// (see tasks/MonitorMcpTask) and returns immediately with the task id. The
// streaming/lifecycle logic lives in the task module.

import { z } from 'zod/v4'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { spawnMonitorMcpTask } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'

export const MONITOR_TOOL_NAME = 'Monitor'

const DEFAULT_TIMEOUT_MS = 300_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 3_600_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .describe(
        'Shell command or script. Each stdout line is an event; exit ends the watch.',
      ),
    description: z
      .string()
      .describe(
        'Short human-readable description of what you are monitoring (shown in notifications).',
      ),
    persistent: z
      .boolean()
      .optional()
      .describe(
        'Run for the lifetime of the session (no timeout). Stop with TaskStop.',
      ),
    timeout_ms: z
      .number()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true.`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string(),
    description: z.string(),
    persistent: z.boolean(),
    outputPath: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'watch a command and notify on each event',
  maxResultSizeChars: 10_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    // Spawns a detached background task; the call itself returns immediately
    // and does not mutate shared turn state.
    return true
  },
  isReadOnly() {
    // Runs an arbitrary shell command — never read-only.
    return false
  },
  toAutoClassifierInput(input: Input) {
    return `Monitor ${input.command}`
  },
  async description(input: Input) {
    return input.description || 'Start a background monitor'
  },
  async prompt() {
    return PROMPT
  },
  async call(input: Input, context: ToolUseContext) {
    const persistent = input.persistent ?? false
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

    const taskId = spawnMonitorMcpTask(
      {
        command: input.command,
        description: input.description,
        persistent,
        timeoutMs,
        toolUseId: context.toolUseId,
        agentId: context.agentId,
      },
      {
        getAppState: context.getAppState,
        // Use the always-shared task channel so background monitors spawned by
        // async agents are actually registered (and killable on agent exit).
        setAppState: context.setAppStateForTasks ?? context.setAppState,
        abortController: context.abortController,
      },
    )

    return {
      data: {
        taskId,
        description: input.description,
        persistent,
        outputPath: getTaskOutputPath(taskId),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const persistentNote = output.persistent
      ? ' (persistent — runs until the session ends or you call TaskStop)'
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Monitor started: ${output.description}${persistentNote}\nTask ID: ${output.taskId}\nEach stdout line arrives as a notification. Output is written to: ${output.outputPath}`,
    }
  },
  renderToolUseMessage(input) {
    return input.description ?? input.command ?? ''
  },
} satisfies ToolDef<InputSchema, Output>)

const PROMPT = `Start a background monitor whose stdout is an event stream — each line becomes a notification delivered to you mid-conversation. Use this for "tell me every time X happens" (e.g. tail -f a log and grep for errors, inotifywait -m a directory, or a poll loop). The script exiting ends the watch.

For a SINGLE completion signal ("tell me when the build finishes"), use Bash with run_in_background and a command that exits when the condition is true — not this tool with an unbounded command.

- Only stdout triggers notifications. Stderr is written to the output file (readable via Read) but does not notify — merge with 2>&1 if you need its lines.
- Make pipes line-buffered (grep --line-buffered, awk fflush()) so matches surface immediately.
- Cover failure paths, not just the happy path: a monitor that only greps for success stays silent through a crash.
- Set persistent: true for session-length watches. Stop early with TaskStop.`
