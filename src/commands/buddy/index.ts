import { feature } from 'bun:bundle'
import type { Command } from '../../commands.js'
import { getCompanion } from '../../buddy/companion.js'
import { RARITY_STARS } from '../../buddy/types.js'
import { isBuddyLive } from '../../buddy/useBuddyNotification.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

// Reaction shown in the sprite's speech bubble when you pet your companion.
const PET_QUIPS = [
  '<3',
  ':)',
  'eee!',
  'best friend',
  'thank you',
  'happy',
] as const

function pickQuip(): string {
  return PET_QUIPS[Math.floor(Math.random() * PET_QUIPS.length)]!
}

const call: LocalCommandCall = async (args, context) => {
  const sub = args.trim().toLowerCase()
  const companion = getCompanion()

  if (!companion) {
    return {
      type: 'text',
      value:
        'You have no companion yet. A companion hatches the first time /buddy runs in a live session.',
    }
  }

  // /buddy pet — record the pet timestamp (CompanionSprite floats hearts while
  // recent) and pop a happy reaction in the bubble.
  if (sub === 'pet') {
    const now = Date.now()
    context.setAppState(prev => ({
      ...prev,
      companionPetAt: now,
      companionReaction: pickQuip(),
    }))
    return {
      type: 'text',
      value: `You pet ${companion.name}.`,
    }
  }

  // /buddy hide / mute — stop rendering the sprite and intro attachment.
  if (sub === 'hide' || sub === 'mute') {
    saveGlobalConfig(c =>
      c.companionMuted ? c : { ...c, companionMuted: true },
    )
    context.setAppState(prev =>
      prev.companionReaction === undefined && prev.companionPetAt === undefined
        ? prev
        : { ...prev, companionReaction: undefined, companionPetAt: undefined },
    )
    return {
      type: 'text',
      value: `${companion.name} is now hidden. Use "/buddy show" to bring them back.`,
    }
  }

  // /buddy show / unmute — render the sprite again.
  if (sub === 'show' || sub === 'unmute') {
    saveGlobalConfig(c =>
      c.companionMuted ? { ...c, companionMuted: false } : c,
    )
    return {
      type: 'text',
      value: `${companion.name} is back.`,
    }
  }

  // No arg (or anything else) — show status.
  const muted = getGlobalConfig().companionMuted
  const stars = RARITY_STARS[companion.rarity]
  return {
    type: 'text',
    value: [
      `${companion.name} — ${companion.rarity} ${stars} ${companion.species}`,
      muted ? '(hidden)' : '(visible)',
      '',
      'Subcommands: pet, show, hide',
    ].join('\n'),
  }
}

const buddy = {
  type: 'local',
  name: 'buddy',
  description: 'Interact with your terminal companion',
  argumentHint: '[pet|show|hide]',
  // feature() must be the direct condition of an if/ternary (bun:bundle macro
  // constraint), so gate via a ternary rather than a logical-AND expression.
  isEnabled: () => (feature('BUDDY') ? isBuddyLive() : false),
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default buddy
