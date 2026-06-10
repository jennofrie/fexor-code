import React, { Suspense, use, useDeferredValue, useEffect, useState } from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import { formatFileSize } from '../../utils/format.js'
import { tailFile } from '../../utils/fsOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>
  onBack?: () => void
  onKill?: () => void
}

// Only tail the last few KB of the event stream, never the whole file.
const MONITOR_DETAIL_TAIL_BYTES = 8192

type MonitorOutputResult = {
  content: string
  bytesTotal: number
}

async function getMonitorOutput(
  task: DeepImmutable<MonitorMcpTaskState>,
): Promise<MonitorOutputResult> {
  const path = getTaskOutputPath(task.id)
  try {
    const result = await tailFile(path, MONITOR_DETAIL_TAIL_BYTES)
    return { content: result.content, bytesTotal: result.bytesTotal }
  } catch {
    return { content: '', bytesTotal: 0 }
  }
}

/**
 * Detail view for a `monitor_mcp` background task. Shows the monitor's status,
 * runtime, the script being watched, the number of stdout events emitted, and a
 * live tail of its event stream. Rendered by BackgroundTasksDialog (gated by
 * feature MONITOR_TOOL). There is no `onDone` — `onBack` closes the dialog.
 */
export function MonitorMcpDetailDialog({
  task,
  onBack,
  onKill,
}: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(
    task.startTime,
    task.status === 'running',
    1000,
    task.totalPausedMs ?? 0,
    task.endTime,
  )

  const [outputPromise, setOutputPromise] = useState(() => getMonitorOutput(task))
  const deferredOutputPromise = useDeferredValue(outputPromise)

  // Refresh the tail while the monitor is still streaming.
  useEffect(() => {
    if (task.status !== 'running') return
    const timer = setInterval(() => {
      setOutputPromise(getMonitorOutput(task))
    }, 1000)
    return () => clearInterval(timer)
  }, [task])

  const handleClose = () => onBack?.()

  // Dialog handles confirm:no (Esc) → onCancel. Wire confirm:yes (Enter/y) too.
  useKeybindings({ 'confirm:yes': handleClose }, { context: 'Confirmation' })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      handleClose()
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Monitor details"
        subtitle={
          <Text dimColor>
            {elapsedTime} · {task.eventCount}{' '}
            {plural(task.eventCount, 'event')}
            {task.persistent ? ' · persistent' : ''}
          </Text>
        }
        onCancel={handleClose}
        color="background"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && (
                <KeyboardShortcutHint shortcut="←" action="go back" />
              )}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              {task.status === 'running' && onKill && (
                <KeyboardShortcutHint shortcut="x" action="stop" />
              )}
            </Byline>
          )
        }
      >
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text bold>Status:</Text>{' '}
              {task.status === 'running' ? (
                <Text color="background">
                  running
                  {task.exitCode !== undefined && ` (exit code: ${task.exitCode})`}
                </Text>
              ) : task.status === 'completed' ? (
                <Text color="success">
                  {task.status}
                  {task.exitCode !== undefined && ` (exit code: ${task.exitCode})`}
                </Text>
              ) : (
                <Text color="error">
                  {task.status}
                  {task.exitCode !== undefined && ` (exit code: ${task.exitCode})`}
                </Text>
              )}
            </Text>
            <Text>
              <Text bold>Runtime:</Text> {elapsedTime}
            </Text>
            <Text wrap="wrap">
              <Text bold>Script:</Text> {task.command}
            </Text>
          </Box>

          <Box flexDirection="column">
            <Text bold>Event stream:</Text>
            <Suspense fallback={<Text dimColor>Loading output…</Text>}>
              <MonitorOutputContent
                outputPromise={deferredOutputPromise}
                running={task.status === 'running'}
              />
            </Suspense>
          </Box>
        </Box>
      </Dialog>
    </Box>
  )
}

type MonitorOutputContentProps = {
  outputPromise: Promise<MonitorOutputResult>
  running: boolean
}

function MonitorOutputContent({
  outputPromise,
  running,
}: MonitorOutputContentProps): React.ReactNode {
  const { content, bytesTotal } = use(outputPromise)
  if (content === '') {
    return (
      <Text dimColor>{running ? 'Waiting for events…' : '(no output)'}</Text>
    )
  }
  return (
    <>
      {bytesTotal > content.length && (
        <Text dimColor>
          (showing last {formatFileSize(content.length)} of{' '}
          {formatFileSize(bytesTotal)})
        </Text>
      )}
      <Text wrap="wrap">{content}</Text>
    </>
  )
}
