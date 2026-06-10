import type { Command } from '../commands.js'
import { snipCompactIfNeeded } from '../services/compact/snipCompact.js'
import type { LocalCommandCall } from '../types/command.js'

const call: LocalCommandCall = async (_args, context) => {
  const result = snipCompactIfNeeded(context.messages, { force: true })

  if (!result.executed) {
    return { type: 'text', value: 'Nothing to snip.' }
  }

  context.setMessages(() => result.messages)

  return {
    type: 'text',
    value: `Snipped history, freed ~${result.tokensFreed} tokens.`,
  }
}

const forceSnip = {
  type: 'local',
  name: 'force-snip',
  description: 'Drop stale conversation history to free up context',
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default forceSnip
