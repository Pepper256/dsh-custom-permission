/**
 * The approval answerer's call-argument recovery: asks that originate inside
 * a tool body (sandbox escalation) carry only `toolName` and `callId`, so the
 * answerer recovers the already-logged `tool/call` arguments from the asking
 * session to evaluate command-level allow rules. The `tool/call` event is
 * appended before the tool body runs and the ask happens inside the same open
 * turn, so the lookup is deterministic; without a call id (or for PTC
 * sub-dispatch calls, which log `tool/code-dispatch` instead) the lookup
 * yields nothing and the answerer delegates.
 * @module dsh-custom-permission/answerer
 */

import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Recover the parsed arguments of the tool call an approval request is about.
 * @param agent - the asking agent, whose session log holds the `tool/call`.
 * @param callId - the exact call identity, when the asker supplied one.
 * @returns the parsed arguments object, or `undefined` when unrecoverable.
 */
export function lookupCallArguments(agent: Agent, callId: ToolCallId | undefined): unknown {
  if (callId === undefined) return undefined
  const events: readonly SessionEvent[] = agent.session.events
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    if (event.data.callId !== callId) continue
    try {
      return JSON.parse(event.data.arguments) as unknown
    } catch {
      // A call whose logged arguments cannot be parsed never existed in the
      // registry's lossless-JSON form; treat it as unrecoverable.
      return undefined
    }
  }
  return undefined
}
