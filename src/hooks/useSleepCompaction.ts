import { randomUUID, type UUID } from 'crypto'
import { useEffect, useRef } from 'react'
import {
  SleepCompactor,
  isSleepCompactionHost,
} from '../services/compact/sleepCompact.js'
import { enqueue } from '../utils/messageQueueManager.js'

type UseSleepCompactionParams = {
  isIdle: boolean
  isStopping: boolean
  isPermissionPending: boolean
  getContextTokens: () => number
}

/**
 * Arms idle ("sleep") compaction whenever the REPL becomes idle.
 *
 * Opt-in through CLAUDE_CODE_SLEEP_COMPACT=1. One compactor instance lives for
 * the hook's lifetime so its handled-request latch survives idle transitions;
 * recreating it after a failed compaction would otherwise re-arm an already
 * past-due timer and enqueue `/compact` repeatedly.
 */
export function useSleepCompaction({
  isIdle,
  isStopping,
  isPermissionPending,
  getContextTokens,
}: UseSleepCompactionParams): void {
  const stateRef = useRef({ isIdle, isStopping, isPermissionPending })
  stateRef.current = { isIdle, isStopping, isPermissionPending }

  const getContextTokensRef = useRef(getContextTokens)
  getContextTokensRef.current = getContextTokens

  const compactorRef = useRef<SleepCompactor | null>(null)

  useEffect(() => {
    if (!isSleepCompactionHost()) {
      return
    }

    if (compactorRef.current === null) {
      const configuredExitDelay = Number(
        process.env.CLAUDE_CODE_EXIT_AFTER_STOP_DELAY
      )
      const exitDelayMs =
        Number.isFinite(configuredExitDelay) && configuredExitDelay > 0
          ? configuredExitDelay
          : undefined

      compactorRef.current = new SleepCompactor({
        isIdle: () => stateRef.current.isIdle,
        isStopping: () => stateRef.current.isStopping,
        isPermissionPending: () => stateRef.current.isPermissionPending,
        getContextTokens: () => getContextTokensRef.current(),
        enqueueCompact: () => {
          enqueue({
            value: '/compact',
            mode: 'prompt',
            priority: 'later',
            isMeta: true,
            uuid: randomUUID() as UUID,
          })
        },
        exitDelayMs,
      })
    }

    if (isIdle) {
      compactorRef.current.arm()
    } else {
      compactorRef.current.cancel()
    }
  }, [isIdle])

  useEffect(
    () => () => {
      compactorRef.current?.cancel()
      compactorRef.current = null
    },
    []
  )
}
