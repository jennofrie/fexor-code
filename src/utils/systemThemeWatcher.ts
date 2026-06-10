/**
 * Live terminal dark/light watcher for the 'auto' theme setting.
 *
 * Loaded lazily (and only when feature('AUTO_THEME') is enabled) by
 * ThemeProvider while 'auto' is the active setting. It queries the terminal's
 * background color via OSC 11, resolves it to a light/dark theme with
 * systemTheme.ts's parser, and notifies the provider on transitions.
 *
 * Terminals don't push an event when their palette changes, so we poll: the
 * first poll fires immediately (correcting the synchronous $COLORFGBG seed),
 * then on a slow interval to pick up live theme switches (e.g. the OS flipping
 * the terminal between dark and light, or the user changing the profile).
 *
 * The OSC 11 round-trip is bounded by the querier's DA1 sentinel (flush()), so
 * there's no timeout to manage and no risk of a hung promise.
 */

import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { oscColor } from '../ink/terminal-querier.js'
import { logForDebugging } from './debug.js'
import {
  setCachedSystemTheme,
  themeFromOscColor,
  type SystemTheme,
} from './systemTheme.js'

/** OSC code 11 = dynamic background color. */
const OSC_BACKGROUND = 11

/** How often to re-query the terminal for live theme changes. */
const POLL_INTERVAL_MS = 5_000

/**
 * Start watching the terminal background color. Calls `onChange` whenever the
 * resolved theme transitions (and once on the first successful poll). Updates
 * systemTheme.ts's module cache so non-React callers stay in sync.
 *
 * Returns a cleanup function that stops polling. Idempotent and safe to call
 * after the watcher has already been torn down.
 */
export function watchSystemTheme(
  querier: TerminalQuerier,
  onChange: (theme: SystemTheme) => void,
): () => void {
  let stopped = false
  let last: SystemTheme | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const poll = async (): Promise<void> => {
    let response
    try {
      // The DA1 sentinel (flush) bounds the round-trip: if the terminal
      // ignores OSC 11, `response` resolves to undefined instead of hanging.
      ;[response] = await Promise.all([
        querier.send(oscColor(OSC_BACKGROUND)),
        querier.flush(),
      ])
    } catch (err) {
      logForDebugging(
        `AUTO_THEME: OSC 11 query failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    if (stopped || !response) return

    const theme = themeFromOscColor(response.data)
    if (!theme || theme === last) return

    last = theme
    setCachedSystemTheme(theme)
    onChange(theme)
  }

  // Fire immediately so the seed from $COLORFGBG is corrected on mount, then
  // poll for live changes.
  void poll()
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
  // Don't keep the event loop alive just to poll the terminal theme.
  timer.unref?.()

  return () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    timer = undefined
  }
}
