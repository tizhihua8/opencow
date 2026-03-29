// SPDX-License-Identifier: Apache-2.0

/**
 * ArtifactViewerContext — lifts artifact viewer dialog state and star management
 * to the SessionPanel level so that neither tab-switching nor isProcessing
 * changes can unmount the dialog.
 *
 * Architecture:
 * - Subscribes to commandStore for session messages and computes artifacts
 *   internally — SessionPanel no longer needs to compute or pass `artifacts`.
 * - Dialog state (useDialogState) lives here, keyed by stable artifact ID
 *   (filePath preferred, contentHash fallback)
 * - Star state (useArtifactStarMap) lives here, shared by all consumers
 * - Child components (ArtifactsView, ArtifactsSummaryBlock) consume via context
 * - ArtifactViewerDialog is rendered by SessionPanel, outside conditional blocks
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useIncrementalMemo } from '@/hooks/useIncrementalMemo'
import type { ManagedSessionMessage } from '@shared/types'
import { useDialogState } from '@/hooks/useModalAnimation'
import { useArtifactStarMap } from './useArtifactStarMap'
import type { StarState } from './useArtifactStarMap'
import { extractSessionArtifacts } from './artifactUtils'
import type { ExtractedArtifact } from './artifactUtils'
import { useAppStore, selectProjectId } from '@/stores/appStore'
import { useCommandStore, selectSessionMessages } from '@/stores/commandStore'

// ─── Stable Identity ─────────────────────────────────────────────────────────

/**
 * Returns a stable identifier for an artifact.
 * Prefers filePath (stable during streaming) over contentHash (changes with content).
 */
export function getArtifactStableId(artifact: ExtractedArtifact): string {
  return artifact.filePath ?? artifact.contentHash
}

/**
 * Looks up an artifact by stable ID: tries filePath first, then contentHash.
 * This ensures the viewer can find the artifact even when contentHash changes
 * during streaming writes.
 */
export function findArtifactByStableId(
  artifacts: ExtractedArtifact[],
  id: string,
): ExtractedArtifact | null {
  return (
    artifacts.find((a) => a.filePath === id) ??
    artifacts.find((a) => a.contentHash === id) ??
    null
  )
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface ArtifactViewerContextValue {
  /** All extracted artifacts for the current session. */
  artifacts: ExtractedArtifact[]
  /** Convenience: `artifacts.length`. Stable primitive for memo deps / badges. */
  artifactCount: number
  /** Whether the viewer dialog is open (drives Dialog `open` prop). */
  viewerOpen: boolean
  /** The artifact currently being viewed, resolved via stable ID lookup. */
  viewingArtifact: ExtractedArtifact | null
  /** Open the viewer for an artifact (pass getArtifactStableId result). */
  showViewer: (id: string) => void
  /** Close the viewer dialog (plays exit animation). */
  closeViewer: () => void
  /** Star state map: contentHash -> StarState. */
  starMap: Map<string, StarState>
  /** Toggle star for an artifact (handles optimistic update + Eager Persist). */
  toggleStar: (artifact: ExtractedArtifact) => void
}

const ArtifactViewerCtx = createContext<ArtifactViewerContextValue | null>(null)

/** Consume the artifact viewer context. Throws if used outside provider. */
export function useArtifactViewerContext(): ArtifactViewerContextValue {
  const ctx = useContext(ArtifactViewerCtx)
  if (!ctx) throw new Error('useArtifactViewerContext must be used within ArtifactViewerProvider')
  return ctx
}

// ─── Provider ────────────────────────────────────────────────────────────────

interface ArtifactViewerProviderProps {
  sessionId: string
  issueId: string | null
  children: ReactNode
}

/**
 * Full-rebuild processor for artifact extraction.
 *
 * extractSessionArtifacts accumulates per-file state (writes/edits count)
 * that makes pure incremental processing infeasible.  Instead, the
 * useIncrementalMemo gate ensures this only runs when messages.length
 * actually increases — not on every sessionMessages reference change.
 *
 * Module-level function to maintain stable reference identity across renders
 * (inline arrows would defeat useMemo dependency tracking).
 */
function rebuildArtifacts(
  _newMsgs: readonly ManagedSessionMessage[],
  _prev: ExtractedArtifact[],
  allMsgs: readonly ManagedSessionMessage[],
): ExtractedArtifact[] {
  return extractSessionArtifacts(allMsgs as ManagedSessionMessage[])
}

const INIT_ARTIFACTS = (): ExtractedArtifact[] => []

export function ArtifactViewerProvider({
  sessionId,
  issueId,
  children,
}: ArtifactViewerProviderProps): React.JSX.Element {
  const selectedProjectId = useAppStore(selectProjectId)

  // Subscribe to messages and derive artifacts — this computation was previously
  // in SessionPanel, causing the entire 756-line component to re-render on
  // every message change.  Now it lives here, scoped to the provider subtree.
  //
  // Uses useIncrementalMemo for sessionId-aware cache invalidation.
  // extractSessionArtifacts accumulates state per file path (writes/edits),
  // so it cannot be made purely incremental.  The message-count gate skips
  // the expensive extraction when sessionMessages reference changes without
  // new content (e.g. streaming → final transition).
  const messages = useCommandStore((s) => selectSessionMessages(s, sessionId))
  const artifacts = useIncrementalMemo<ManagedSessionMessage, ExtractedArtifact[]>(
    messages,
    sessionId,
    rebuildArtifacts,
    INIT_ARTIFACTS,
  )

  // Dialog state — keyed by stable artifact ID (filePath ?? contentHash)
  const viewer = useDialogState<string>()

  // Resolve the currently viewed artifact via stable ID lookup
  const viewingArtifact = useMemo(
    () => (viewer.data ? findArtifactByStableId(artifacts, viewer.data) : null),
    [artifacts, viewer.data],
  )

  // Shared star state
  const { starMap, toggleStar } = useArtifactStarMap({
    sessionId,
    issueId,
    projectId: selectedProjectId ?? null,
  })

  const value = useMemo<ArtifactViewerContextValue>(
    () => ({
      artifacts,
      artifactCount: artifacts.length,
      viewerOpen: viewer.open,
      viewingArtifact,
      showViewer: viewer.show,
      closeViewer: viewer.close,
      starMap,
      toggleStar,
    }),
    [artifacts, viewer.open, viewingArtifact, viewer.show, viewer.close, starMap, toggleStar],
  )

  return <ArtifactViewerCtx.Provider value={value}>{children}</ArtifactViewerCtx.Provider>
}
