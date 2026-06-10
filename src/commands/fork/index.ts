/**
 * /fork — branch the current conversation into a background subagent.
 *
 * Gated behind FORK_SUBAGENT. When the fork experiment is active the model
 * already defaults to forking (Agent tool with no subagent_type → inherits the
 * full parent context, see forkSubagent.ts). This slash command is the
 * user-facing entrypoint: it takes a directive and injects the fork
 * boilerplate message that drives the spawn.
 *
 * The injected message is built with buildChildMessage(), which wraps the
 * directive in a <fork-boilerplate> tag. The transcript renderer
 * (UserTextMessage → UserForkBoilerplateMessage) already collapses that tag and
 * shows only the directive, so the user sees a clean entry while the model
 * receives the full fork instructions.
 */
import type { Command, LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { buildChildMessage, isForkSubagentEnabled } from '../../tools/AgentTool/forkSubagent.js'

async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const directive = args?.trim()

  if (!directive) {
    onDone('Usage: /fork <directive for the forked worker>', {
      display: 'system',
    })
    return null
  }

  // Inject the fork directive as a model-visible (user-hidden) message and let
  // the main loop act on it. buildChildMessage wraps the directive in the
  // <fork-boilerplate> marker the UI already renders.
  onDone(undefined, {
    display: 'skip',
    metaMessages: [buildChildMessage(directive)],
    shouldQuery: true,
  })

  return null
}

const fork = {
  type: 'local-jsx',
  name: 'fork',
  description:
    'Branch the current conversation into a background worker. /fork <directive>',
  isEnabled: () => isForkSubagentEnabled(),
  argumentHint: '<directive for the forked worker>',
  immediate: true,
  load: async () => ({ call }),
} satisfies Command

export default fork
