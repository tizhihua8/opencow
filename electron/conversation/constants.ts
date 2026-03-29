// SPDX-License-Identifier: Apache-2.0

/**
 * Shared constants for the conversation pipeline.
 *
 * Centralises magic numbers used across domain reducer, stream state,
 * and dispatch throttle — ensuring a single source of truth for
 * streaming frequency limits.
 */

/**
 * Maximum interval between IPC dispatches for streaming updates (~20 fps).
 *
 * Used by:
 *   - DispatchThrottle (assistant.partial / tool.progress / hook_progress coalescing)
 *   - ToolProgressRelay (Evose relay default throttle)
 *
 * 50 ms ≈ 20 dispatches/sec.  Each dispatch carries a full message snapshot
 * via Electron structured-clone (~1-50 KB depending on response length).
 * At 60 fps (16 ms) the per-frame IPC serialisation cost grew linearly with
 * message size and consumed 1-5 ms of the renderer's 16 ms frame budget,
 * leaving insufficient headroom for input handling and scroll events — causing
 * perceptible UI lag during active streaming.
 *
 * Raising the interval to 50 ms reduces IPC dispatches by ~66%, freeing
 * ~3-8 ms/frame for user interaction.  The renderer's write-coalescing buffer
 * (`useAppBootstrap.ts`) further batches these into at most one Zustand
 * store update per 33 ms, so the visual streaming cadence is ~20-30 fps —
 * perceptually smooth for text content.
 *
 * Terminal events (assistant.final, turn.result, protocol.violation) call
 * `DispatchThrottle.flushNow()` and bypass this interval entirely, so final
 * messages are never delayed.
 */
export const DISPATCH_THROTTLE_INTERVAL_MS = 50
