import React, { useCallback, useMemo } from 'react'
import { Box, Text, useTheme } from '../../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import { env } from '../../../utils/env.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../../utils/stringUtils.js'
import { logUnaryEvent } from '../../../utils/unaryLogging.js'
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from '../PermissionPrompt.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'

type MonitorOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

/**
 * Permission prompt for the Monitor tool (feature MONITOR_TOOL). A monitor runs
 * a shell command whose stdout is streamed back as notifications, so the prompt
 * makes the streaming-watcher nature explicit before the user grants it.
 *
 * Shares the exact prop contract of FallbackPermissionRequest so it can be used
 * interchangeably (`MonitorPermissionRequest ?? FallbackPermissionRequest`).
 */
export function MonitorPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose: _verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [theme] = useTheme()

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const handleSelect = useCallback(
    (value: MonitorOptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-dont-ask-again': {
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })

          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [
                {
                  toolName: toolUseConfirm.tool.name,
                },
              ],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        }
        case 'no':
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject],
  )

  const handleCancel = useCallback(() => {
    void logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions()
  const options = useMemo((): PermissionPromptOption<MonitorOptionValue>[] => {
    const result: PermissionPromptOption<MonitorOptionValue>[] = [
      {
        label: 'Yes, start monitoring',
        value: 'yes',
        feedbackConfig: { type: 'accept' },
      },
    ]

    if (showAlwaysAllowOptions) {
      result.push({
        label: <Text>Yes, and don&apos;t ask again for monitors</Text>,
        value: 'yes-dont-ask-again',
      })
    }

    result.push({
      label: 'No',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })

    return result
  }, [showAlwaysAllowOptions])

  const toolAnalyticsContext = useMemo(
    (): ToolAnalyticsContext => ({
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  return (
    <PermissionDialog title="Start monitor" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {toolUseConfirm.tool.renderToolUseMessage(
            toolUseConfirm.input as never,
            { theme, verbose: true },
          )}
        </Text>
        <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
        <Text dimColor>
          Each line the script prints to stdout is delivered to Claude as a
          live notification until the script exits.
        </Text>
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}
