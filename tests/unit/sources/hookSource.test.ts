// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm, stat, appendFile } from 'fs/promises'
import { join } from 'path'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import type { DataBusEvent } from '@shared/types'
import { HookSource } from '../../../electron/sources/hookSource'

function makeEventLine(
  hookEventName: string,
  sessionId = 'sess-1',
  extras: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    payload: {
      session_id: sessionId,
      hook_event_name: hookEventName,
      cwd: '/test',
      ...extras,
    },
  })
}

/**
 * Helper: start and immediately stop a HookSource.
 * This runs the startup sequence (consume → truncate) but stops the live
 * watcher and rotation timer, giving us a deterministic object for manual
 * readNewEvents / rotateIfNeeded calls in tests.
 */
async function createStartedSource(
  dispatch: (e: DataBusEvent) => void,
  config: { eventsLog: string; shouldSkip?: (e: any) => boolean },
): Promise<HookSource> {
  const source = new HookSource(dispatch, config)
  await source.start()
  source.stop() // Kill watcher + rotation timer — tests call methods explicitly
  return source
}

describe('HookSource', () => {
  let tempDir: string
  let eventsLog: string
  let dispatched: DataBusEvent[]

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencow-hook-'))
    eventsLog = join(tempDir, 'events.jsonl')
    dispatched = []
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // Startup: consume → clear
  // ---------------------------------------------------------------------------

  describe('startup: consume then clear', () => {
    it('consumes surviving events then clears the file', async () => {
      // Simulate crash-recovery: events survived from previous session
      const oldEvents = [
        makeEventLine('SessionStart'),
        makeEventLine('Stop'),
      ].join('\n') + '\n'
      await writeFile(eventsLog, oldEvents, 'utf-8')

      const source = new HookSource((e) => dispatched.push(e), { eventsLog })
      await source.start()
      source.stop()

      // Events WERE consumed (dispatched to bus)
      expect(dispatched).toHaveLength(2)
      expect((dispatched[0].payload as any).rawEventName).toBe('SessionStart')
      expect((dispatched[1].payload as any).rawEventName).toBe('Stop')

      // File truncated after consumption
      const fileStat = await stat(eventsLog)
      expect(fileStat.size).toBe(0)
    })

    it('handles missing file gracefully', async () => {
      const source = new HookSource((e) => dispatched.push(e), { eventsLog })
      await source.start()
      source.stop()
      expect(dispatched).toHaveLength(0)
    })

    it('handles empty file', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = new HookSource((e) => dispatched.push(e), { eventsLog })
      await source.start()
      source.stop()
      expect(dispatched).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Incremental reading
  // ---------------------------------------------------------------------------

  describe('incremental reading', () => {
    it('reads new events appended after start', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // Simulate shell appending events
      await appendFile(eventsLog,
        makeEventLine('SessionStart', 'sess-new') + '\n' +
        makeEventLine('Stop', 'sess-new') + '\n')

      await source.readNewEvents()

      expect(dispatched).toHaveLength(2)
      expect((dispatched[0].payload as any).sessionId).toBe('sess-new')
    })

    it('reads incrementally — does not re-dispatch old events', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // First batch
      await appendFile(eventsLog, makeEventLine('SessionStart', 'a') + '\n')
      await source.readNewEvents()
      expect(dispatched).toHaveLength(1)

      // Second batch — only new events
      await appendFile(eventsLog, makeEventLine('Stop', 'b') + '\n')
      await source.readNewEvents()
      expect(dispatched).toHaveLength(2)
      expect((dispatched[1].payload as any).sessionId).toBe('b')
    })

    it('resets offset when file shrinks (external truncation)', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // Write and consume
      await appendFile(eventsLog, makeEventLine('SessionStart') + '\n')
      await source.readNewEvents()
      const count1 = dispatched.length

      // External truncation (e.g. rotation by another process)
      await writeFile(eventsLog, '', 'utf-8')

      // New event after truncation
      await appendFile(eventsLog, makeEventLine('Stop', 'new') + '\n')
      await source.readNewEvents()

      expect(dispatched.length).toBeGreaterThan(count1)
    })
  })

  // ---------------------------------------------------------------------------
  // Trailing-line buffer (Fix 2: partial line handling)
  // ---------------------------------------------------------------------------

  describe('trailing-line buffer', () => {
    it('buffers a partial line and completes it on next read', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      const fullLine = makeEventLine('SessionStart', 'sess-partial')
      const half1 = fullLine.slice(0, Math.floor(fullLine.length / 2))
      const half2 = fullLine.slice(Math.floor(fullLine.length / 2))

      // Write first half (no newline → incomplete line)
      await writeFile(eventsLog, half1, 'utf-8')
      await source.readNewEvents()
      expect(dispatched).toHaveLength(0) // Still buffered

      // Write second half + newline
      await appendFile(eventsLog, half2 + '\n')
      await source.readNewEvents()
      expect(dispatched).toHaveLength(1)
      expect((dispatched[0].payload as any).sessionId).toBe('sess-partial')
    })

    it('handles complete lines followed by a partial trailing line', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      const line1 = makeEventLine('SessionStart', 'a')
      const line2 = makeEventLine('Stop', 'b')
      const partialLine3 = makeEventLine('SessionStart', 'c').slice(0, 20)

      // Two complete + one partial (no trailing newline)
      await writeFile(eventsLog, line1 + '\n' + line2 + '\n' + partialLine3, 'utf-8')
      await source.readNewEvents()

      // Two events dispatched, partial buffered
      expect(dispatched).toHaveLength(2)
      expect((dispatched[0].payload as any).sessionId).toBe('a')
      expect((dispatched[1].payload as any).sessionId).toBe('b')
    })

    it('clears trailing buffer on file truncation (offset reset)', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // Write partial line
      const partial = makeEventLine('SessionStart').slice(0, 20)
      await writeFile(eventsLog, partial, 'utf-8')
      await source.readNewEvents()
      expect(dispatched).toHaveLength(0)

      // File shrinks → trailing buffer should be cleared
      await writeFile(eventsLog, '', 'utf-8')
      // Write fresh complete line
      await appendFile(eventsLog, makeEventLine('Stop', 'fresh') + '\n')
      await source.readNewEvents()

      expect(dispatched).toHaveLength(1)
      expect((dispatched[0].payload as any).sessionId).toBe('fresh')
    })
  })

  // ---------------------------------------------------------------------------
  // Serialization (Fix 3: busy flag)
  // ---------------------------------------------------------------------------

  describe('serialization', () => {
    it('concurrent readNewEvents calls do not duplicate events', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      await appendFile(eventsLog, makeEventLine('SessionStart') + '\n')

      // Fire two reads concurrently — second sets pendingRead, first re-drains
      const p1 = source.readNewEvents()
      const p2 = source.readNewEvents()
      await Promise.all([p1, p2])

      expect(dispatched).toHaveLength(1)
    })

    it('pendingRead flag re-drains events written during a busy read', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // Write event A, then start reading
      await appendFile(eventsLog, makeEventLine('SessionStart', 'a') + '\n')

      // First read picks up event A. While it's "busy", simulate another
      // call that would set pendingRead — then event B is appended.
      // Because we use createStartedSource (no watcher), we rely on the
      // re-drain loop: event B should be picked up in the same readNewEvents call.
      const p1 = source.readNewEvents()
      // Append event B and trigger another read (sets pendingRead)
      await appendFile(eventsLog, makeEventLine('Stop', 'b') + '\n')
      const p2 = source.readNewEvents()
      await Promise.all([p1, p2])

      // Both events should be dispatched — B via the re-drain loop
      expect(dispatched).toHaveLength(2)
      expect((dispatched[0].payload as any).sessionId).toBe('a')
      expect((dispatched[1].payload as any).sessionId).toBe('b')
    })
  })

  // ---------------------------------------------------------------------------
  // Size-based rotation (Fix 4: append-create)
  // ---------------------------------------------------------------------------

  describe('rotation', () => {
    it('rotates when file exceeds MAX_FILE_SIZE', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // Write >10 MB to trigger rotation
      await writeFile(eventsLog, 'x'.repeat(11 * 1024 * 1024), 'utf-8')

      await source.rotateIfNeeded()

      // Active file re-created (0 bytes or small if a race happened)
      const fileStat = await stat(eventsLog)
      expect(fileStat.size).toBeLessThan(1024) // Essentially empty

      // Archive exists with original content
      const base = eventsLog.replace(/\.jsonl$/, '')
      const archiveStat = await stat(`${base}.1.jsonl`).catch(() => null)
      expect(archiveStat).not.toBeNull()
      expect(archiveStat!.size).toBeGreaterThan(10 * 1024 * 1024)
    })

    it('does not rotate when file is under threshold', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      await appendFile(eventsLog, makeEventLine('SessionStart') + '\n')

      await source.rotateIfNeeded()

      // File unchanged
      const fileStat = await stat(eventsLog)
      expect(fileStat.size).toBeGreaterThan(0)

      // No archive created
      const base = eventsLog.replace(/\.jsonl$/, '')
      expect(await stat(`${base}.1.jsonl`).catch(() => null)).toBeNull()
    })

    it('cascades archives: events.1.jsonl → events.2.jsonl', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      const base = eventsLog.replace(/\.jsonl$/, '')

      // Pre-existing archive
      await writeFile(`${base}.1.jsonl`, 'old-archive\n', 'utf-8')

      // Trigger rotation
      await writeFile(eventsLog, 'x'.repeat(11 * 1024 * 1024), 'utf-8')
      await source.rotateIfNeeded()

      // Old .1 cascaded to .2
      const stat2 = await stat(`${base}.2.jsonl`).catch(() => null)
      expect(stat2).not.toBeNull()

      // New .1 contains the 11MB
      const stat1 = await stat(`${base}.1.jsonl`).catch(() => null)
      expect(stat1).not.toBeNull()
      expect(stat1!.size).toBeGreaterThan(10 * 1024 * 1024)
    })

    it('uses append-create (does not clobber concurrent shell writes)', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), { eventsLog })

      // Write >10 MB
      await writeFile(eventsLog, 'x'.repeat(11 * 1024 * 1024), 'utf-8')
      await source.rotateIfNeeded()

      // Simulate shell writing to the newly created file
      await appendFile(eventsLog, makeEventLine('SessionStart', 'post-rotation') + '\n')

      // Read should pick up the post-rotation event
      await source.readNewEvents()
      const postRotation = dispatched.filter(
        (e) => (e.payload as any).sessionId === 'post-rotation'
      )
      expect(postRotation).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // shouldSkip predicate
  // ---------------------------------------------------------------------------

  describe('shouldSkip', () => {
    it('drops events when shouldSkip returns true', async () => {
      await writeFile(eventsLog, '', 'utf-8')
      const source = await createStartedSource((e) => dispatched.push(e), {
        eventsLog,
        shouldSkip: (event) => event.sessionId === 'skip-me',
      })

      await appendFile(eventsLog,
        makeEventLine('SessionStart', 'skip-me') + '\n' +
        makeEventLine('SessionStart', 'keep-me') + '\n')
      await source.readNewEvents()

      expect(dispatched).toHaveLength(1)
      expect((dispatched[0].payload as any).sessionId).toBe('keep-me')
    })
  })
})
