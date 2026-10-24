// Upstream 2.1.217: cap concurrently-running subagents so one message cannot
// fan out unbounded agents. The cap is enforced for top-level agents only;
// nested agents bypass it to avoid parent/child slot deadlocks.
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20;

function getMaxConcurrentSubagents(): number {
  const raw = Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : DEFAULT_MAX_CONCURRENT_SUBAGENTS;
}

let activeAgents = 0;
const waiters: Array<() => void> = [];

function releaseAgentSlot(): void {
  const next = waiters.shift();
  if (next) {
    // Transfer the slot without decrementing so the waiter resumes exactly
    // once and the active count stays accurate.
    next();
    return;
  }
  activeAgents = Math.max(0, activeAgents - 1);
}

/**
 * Acquire a subagent slot. Resolves with an idempotent release function.
 */
export function acquireAgentSlot(): Promise<() => void> {
  if (activeAgents < getMaxConcurrentSubagents()) {
    activeAgents += 1;
    return Promise.resolve(releaseAgentSlot);
  }

  return new Promise((resolve) => {
    waiters.push(() => resolve(releaseAgentSlot));
  });
}
