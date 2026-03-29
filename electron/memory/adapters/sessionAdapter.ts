// SPDX-License-Identifier: Apache-2.0

import type { InteractionSourceAdapter, InteractionEvent } from '../types'

/**
 * Converts session idle/stopped events into InteractionEvents.
 *
 * Does NOT require `result` in the event payload (it's rarely populated).
 * Instead, the MemoryService resolves session content via getSessionContent().
 * This adapter gates on event type, stop reason, and origin source.
 */
export class SessionInteractionAdapter implements InteractionSourceAdapter {
  sourceType = 'session' as const

  shouldProcess(eventType: string, data: Record<string, unknown>): boolean {
    if (eventType !== 'command:session:idle' && eventType !== 'command:session:stopped') {
      return false
    }

    // Only process sessions that completed or idled normally
    const stopReason = data.stopReason as string | undefined
    if (stopReason === 'error' || stopReason === 'cancelled') return false

    // Must have a sessionId
    if (!data.sessionId) return false

    // Exclude non-conversational sessions — no user memories to extract
    const origin = data.origin as Record<string, unknown> | undefined
    const originSource = typeof origin?.source === 'string' ? origin.source : undefined
    if (originSource === 'market-analyzer' || originSource === 'schedule') return false

    return true
  }

  toInteractionEvent(eventType: string, data: Record<string, unknown>): InteractionEvent | null {
    const sessionId = data.sessionId as string | undefined
    const origin = data.origin as Record<string, unknown> | undefined

    if (!sessionId) return null

    // Content + project context are resolved later by MemoryService via getSessionContext().
    // SessionOrigin does not carry projectId/projectName — those come from the session snapshot.
    return {
      type: 'session',
      projectId: null,
      sessionId,
      content: '',
      metadata: {
        stopReason: typeof data.stopReason === 'string' ? data.stopReason : undefined,
        originSource: typeof origin?.source === 'string' ? origin.source : undefined,
      },
      timestamp: Date.now(),
    }
  }
}
