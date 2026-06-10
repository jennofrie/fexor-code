// Background task counterpart for the Monitor tool (feature MONITOR_TOOL).
//
// A monitor runs a shell command/script whose stdout is an event stream: each
// stdout line becomes a notification delivered to the model mid-conversation.
// The script exiting ends the watch; a timeout (non-persistent monitors) kills
// it. This is a streaming watcher, distinct from `local_bash` background tasks
// (which deliver a single completion notification). The task type is
// `monitor_mcp` and is surfaced in the footer pill and Background Tasks dialog.
//
// This module is intentionally non-React so non-UI consumers (runAgent.ts) can
// kill agent-scoped monitors without pulling Ink into their module graph (same
// rationale as LocalShellTask/guards.ts and killShellTasks.ts).

import { type ChildProcess, spawn } from 'child_process'
import treeKill from 'tree-kill'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logError } from '../../utils/log.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  appendTaskOutput,
  evictTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'

// Stdout lines emitted within this window collapse into a single notification
// so multi-line output from one underlying event groups naturally (mirrors the
// harness Monitor's 200ms batching).
const EVENT_BATCH_MS = 200

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  /** The shell command/script whose stdout is the event stream. */
  command: string
  /** When true, runs for the session lifetime (no timeout). */
  persistent: boolean
  /** Number of stdout events (notifications) emitted so far. */
  eventCount: number
  /** Exit code of the script, once it has exited. */
  exitCode?: number
  /** Live process handle; cleared on terminal transition. */
  child?: ChildProcess
  /** Agent that spawned this monitor; undefined = main thread. */
  agentId?: AgentId
}

export function isMonitorMcpTask(task: unknown): task is MonitorMcpTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    (task as { type: unknown }).type === 'monitor_mcp'
  )
}

type SpawnMonitorInput = {
  command: string
  description: string
  persistent: boolean
  /** Deadline in ms for non-persistent monitors. Ignored when persistent. */
  timeoutMs: number
  toolUseId?: string
  agentId?: AgentId
}

type SpawnMonitorContext = {
  getAppState: () => AppState
  setAppState: SetAppState
  abortController?: AbortController
}

/**
 * Spawn a background monitor: start the script, register a `monitor_mcp` task,
 * stream each batch of stdout lines as a notification, and transition the task
 * to a terminal state when the script exits, times out, or is killed.
 *
 * Returns the task id so the caller (MonitorTool) can report it to the model.
 */
export function spawnMonitorMcpTask(
  input: SpawnMonitorInput,
  context: SpawnMonitorContext,
): string {
  const { command, description, persistent, timeoutMs, toolUseId, agentId } =
    input
  const { setAppState } = context

  const taskId = generateTaskId('monitor_mcp')

  const child = spawn(command, {
    shell: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const taskState: MonitorMcpTaskState = {
    ...createTaskStateBase(taskId, 'monitor_mcp', description, toolUseId),
    type: 'monitor_mcp',
    status: 'running',
    command,
    persistent,
    eventCount: 0,
    child,
    agentId,
  }
  registerTask(taskState, setAppState)

  // Buffer partial lines across chunks; only emit complete lines as events.
  let stdoutCarry = ''
  let pendingLines: string[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flushPending = (): void => {
    flushTimer = null
    if (pendingLines.length === 0) return
    const lines = pendingLines
    pendingLines = []
    const body = lines.join('\n')
    appendTaskOutput(taskId, `${body}\n`)
    let total = lines.length
    updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task
      total = task.eventCount + lines.length
      return { ...task, eventCount: total }
    })
    enqueueMonitorNotification({
      taskId,
      description,
      status: 'running',
      summary: `Monitor "${description}" — ${body}`,
      toolUseId,
      agentId,
    })
  }

  const onStdout = (chunk: Buffer | string): void => {
    const text = stdoutCarry + chunk.toString()
    const parts = text.split('\n')
    stdoutCarry = parts.pop() ?? ''
    for (const line of parts) {
      if (line.length > 0) pendingLines.push(line)
    }
    if (pendingLines.length > 0 && flushTimer === null) {
      flushTimer = setTimeout(flushPending, EVENT_BATCH_MS)
    }
  }

  // Stderr is written to the output file (readable via Read) but does NOT
  // trigger notifications — matching the harness Monitor contract.
  const onStderr = (chunk: Buffer | string): void => {
    appendTaskOutput(taskId, chunk.toString())
  }

  child.stdout?.setEncoding('utf-8')
  child.stdout?.on('data', onStdout)
  child.stderr?.setEncoding('utf-8')
  child.stderr?.on('data', onStderr)

  // Non-persistent monitors are killed at the deadline.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  if (!persistent) {
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null
      killMonitorChild(child)
      finalize('killed', undefined)
    }, timeoutMs)
  }

  // Abort signal (turn cancel) tears the monitor down.
  const onAbort = (): void => {
    killMonitorChild(child)
    finalize('killed', undefined)
  }
  context.abortController?.signal.addEventListener('abort', onAbort, {
    once: true,
  })

  let finalized = false
  function finalize(
    terminal: 'completed' | 'failed' | 'killed',
    exitCode: number | undefined,
  ): void {
    if (finalized) return
    finalized = true
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushPending()
    }
    // Drain any buffered trailing line (script wrote a final line without \n).
    if (stdoutCarry.length > 0) {
      pendingLines.push(stdoutCarry)
      stdoutCarry = ''
      flushPending()
    }
    context.abortController?.signal.removeEventListener('abort', onAbort)

    updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task
      return {
        ...task,
        status: terminal,
        exitCode,
        child: undefined,
        endTime: Date.now(),
      }
    })
    enqueueMonitorTerminalNotification({
      taskId,
      description,
      status: terminal,
      exitCode,
      setAppState,
      toolUseId,
      agentId,
    })
    void evictTaskOutput(taskId)
  }

  child.on('error', err => {
    logError(err)
    finalize('failed', undefined)
  })
  child.on('exit', (code, signal) => {
    if (finalized) return
    if (signal) {
      finalize('killed', undefined)
    } else {
      finalize(code === 0 ? 'completed' : 'failed', code ?? undefined)
    }
  })

  return taskId
}

function killMonitorChild(child: ChildProcess | undefined): void {
  if (!child?.pid) return
  try {
    treeKill(child.pid)
  } catch (err) {
    logError(err)
  }
}

/**
 * Kill a single running monitor by id. Used by the Background Tasks dialog and
 * the Task.kill dispatch (TaskStopTool / SDK stop_task).
 */
export function killMonitorMcp(taskId: string, setAppState: SetAppState): void {
  let child: ChildProcess | undefined
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    child = task.child
    return {
      ...task,
      status: 'killed',
      notified: true,
      child: undefined,
      endTime: Date.now(),
    }
  })
  killMonitorChild(child)
  void evictTaskOutput(taskId)
}

/**
 * Kill all running monitors spawned by a given agent. Called from runAgent.ts
 * so monitors don't outlive the agent that started them.
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isMonitorMcpTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      killMonitorMcp(taskId, setAppState)
    }
  }
}

function enqueueMonitorNotification(opts: {
  taskId: string
  description: string
  status: 'running'
  summary: string
  toolUseId?: string
  agentId?: AgentId
}): void {
  const { taskId, status, summary, toolUseId, agentId } = opts
  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>monitor_mcp</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
  // 'next' mirrors LocalShellTask's MONITOR_TOOL path: deliver between the
  // current tool result and the next API round-trip rather than end-of-turn.
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
    agentId,
  })
}

function enqueueMonitorTerminalNotification(opts: {
  taskId: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  exitCode: number | undefined
  setAppState: SetAppState
  toolUseId?: string
  agentId?: AgentId
}): void {
  const { taskId, description, status, exitCode, setAppState, toolUseId, agentId } =
    opts
  // Atomically claim the notified flag to avoid double-notifying (e.g. when
  // killMonitorMcp already set notified before exit fired).
  let shouldEnqueue = false
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  let summary: string
  switch (status) {
    case 'completed':
      summary = `Monitor "${description}" stream ended`
      break
    case 'failed':
      summary = `Monitor "${description}" script failed${
        exitCode !== undefined ? ` (exit ${exitCode})` : ''
      }`
      break
    case 'killed':
      summary = `Monitor "${description}" stopped`
      break
  }

  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>monitor_mcp</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
    agentId,
  })
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId, setAppState) {
    killMonitorMcp(taskId, setAppState)
  },
}
