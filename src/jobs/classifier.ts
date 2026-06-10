import { writeFileSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage } from '../types/message.js'

type JobState = {
  status: 'running' | 'awaiting_input'
  updatedAt: string
  turns: number
}

// Classify a dispatched template job's state from the latest assistant turn and
// persist it to <jobDir>/state.json so `claude list` shows live status. A turn
// that ends with a pending tool_use is still 'running'; a text-only turn means
// the agent finished its turn and is awaiting the next input. Best-effort — the
// caller (stopHooks) awaits it inside a .catch, so it must never throw fatally.
export async function classifyAndWriteState(
  jobDir: string,
  assistantMessages: AssistantMessage[],
): Promise<void> {
  const last = assistantMessages[assistantMessages.length - 1]
  const content = (last?.message?.content ?? []) as Array<{ type?: string }>
  const hasPendingTool =
    Array.isArray(content) && content.some(b => b?.type === 'tool_use')
  const state: JobState = {
    status: hasPendingTool ? 'running' : 'awaiting_input',
    updatedAt: new Date().toISOString(),
    turns: assistantMessages.length,
  }
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify(state, null, 2))
}
