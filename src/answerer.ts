/**
 * The approval answerer's call-argument recovery: asks that originate inside
 * a tool body (sandbox escalation) carry only `toolName` and `callId`, so the
 * answerer needs the already-dispatched call's arguments to evaluate
 * command-level allow rules. The plugin records every call's arguments in its
 * `tools/pre-execute` listener — the pipeline stage that runs immediately
 * before the tool body — and looks them up by call id here. The cache is
 * bounded so a long session cannot retain every call.
 * @module dsh-custom-permission/answerer
 */

/** Recorded arguments of one recently dispatched tool call. */
export interface CallArgumentsCache {
  /** Record (or replace) one call's arguments, evicting the oldest entry past the bound. */
  remember(callId: string, args: unknown): void
  /** Look up one call's arguments by call id. */
  lookup(callId: string): unknown
}

/** The default number of retained calls; comfortably larger than one turn's tool batch. */
const DEFAULT_CAPACITY = 256

/**
 * Create a bounded FIFO cache of tool-call arguments keyed by call id.
 * @param capacity - maximum retained calls (oldest evicted first).
 * @returns the cache used by the approval answerer.
 */
export function createCallArgumentsCache(capacity: number = DEFAULT_CAPACITY): CallArgumentsCache {
  const entries = new Map<string, unknown>()
  return {
    remember(callId: string, args: unknown): void {
      entries.delete(callId)
      entries.set(callId, args)
      while (entries.size > capacity) {
        const oldest = entries.keys().next()
        if (oldest.done === true) return
        entries.delete(oldest.value)
      }
    },
    lookup(callId: string): unknown {
      return entries.get(callId)
    },
  }
}
