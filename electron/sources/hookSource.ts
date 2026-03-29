// SPDX-License-Identifier: Apache-2.0

import { watch, stat, mkdir, rename, unlink, open } from 'fs/promises'
import { dirname, join, parse as parsePath } from 'path'
import { parseHookLogLine } from '../parsers/hookEventParser'
import type { DataBusEvent, HookEvent } from '@shared/types'
import { createLogger } from '../platform/logger'

const log = createLogger('HookSource')

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Rotate when the active events file exceeds this size. */
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** Number of rotated archive files to keep (events.1.jsonl … events.N.jsonl). */
const MAX_ROTATED_FILES = 3

/** How often (ms) to check whether rotation is needed. */
const ROTATION_CHECK_INTERVAL = 60_000 // 1 min

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HookSourceConfig {
  /** Path to the events.jsonl file to watch. */
  eventsLog: string
  /**
   * Optional predicate — when it returns `true` for an event, that event
   * is silently dropped instead of being dispatched.
   *
   * Primary use: suppress CLI hook events for managed sessions (SDK
   * programmatic hooks are the authoritative source for those sessions).
   */
  shouldSkip?: (event: HookEvent) => boolean
}

// ---------------------------------------------------------------------------
// HookSource
// ---------------------------------------------------------------------------

export class HookSource {
  private readonly dispatch: (event: DataBusEvent) => void
  private readonly eventsLog: string
  private readonly shouldSkip: ((event: HookEvent) => boolean) | undefined

  private abortController: AbortController | null = null
  private rotationTimer: ReturnType<typeof setInterval> | null = null

  /** Byte offset into events.jsonl up to which we have consumed content. */
  private readOffset = 0

  /**
   * Trailing bytes from the last read that did not end with '\n'.
   * This handles the case where the external shell writer is mid-write
   * when we stat + read — we'd capture a partial JSON line that would
   * fail to parse. By buffering it we seamlessly rejoin it on the next read.
   */
  private trailingLine = ''

  /**
   * Mutual-exclusion flag to serialize {@link readNewEvents} and
   * {@link rotateIfNeeded}. Both are triggered asynchronously (fs.watch and
   * setInterval) and share mutable state (readOffset, trailingLine, file).
   */
  private busy = false

  /**
   * Set when a read is requested while `busy` is true. Ensures we re-drain
   * after the current operation finishes — otherwise events written during a
   * read would be silently lost if no subsequent fs.watch event arrives.
   */
  private pendingRead = false

  constructor(dispatch: (event: DataBusEvent) => void, config: HookSourceConfig) {
    this.dispatch = dispatch
    this.eventsLog = config.eventsLog
    this.shouldSkip = config.shouldSkip
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    await mkdir(dirname(this.eventsLog), { recursive: true })

    // Consume any events that survived from a previous session, then clear.
    // In the current startup sequence (main.ts) events dispatched here have
    // no listeners yet (wireEventRoutes runs later), so they are effectively
    // discarded — but we maintain the "consume → clear" invariant so that
    // a future refactoring that wires routes earlier won't silently lose data.
    await this.readNewEvents()
    await this.clearConsumedEvents()

    this.abortController = new AbortController()
    this.watchFile(this.abortController.signal)
    this.startRotationCheck()
    log.info('HookSource started', { eventsLog: this.eventsLog })
  }

  stop(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer)
      this.rotationTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    log.info('HookSource stopped', { eventsLog: this.eventsLog })
  }

  // -----------------------------------------------------------------------
  // File watcher
  // -----------------------------------------------------------------------

  private async watchFile(signal: AbortSignal): Promise<void> {
    const RETRY_INTERVAL = 2000
    while (!signal.aborted) {
      try {
        const watcher = watch(this.eventsLog, { signal })
        for await (const event of watcher) {
          if (event.eventType === 'change') {
            await this.readNewEvents()
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).name === 'AbortError') break
        log.warn('Watch loop error; retrying', { eventsLog: this.eventsLog }, err)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RETRY_INTERVAL)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
    }
  }

  // -----------------------------------------------------------------------
  // Incremental reader — offset-based, with trailing-line buffer
  // -----------------------------------------------------------------------

  /**
   * Read and dispatch new events appended since our last read.
   *
   * Key invariants:
   * - Only new bytes (from readOffset to current file size) are loaded.
   * - A trailing incomplete line is buffered and prepended to the next read.
   * - Serialized with {@link rotateIfNeeded} via the `busy` flag.
   * - If called while busy, a `pendingRead` flag is set so the current
   *   operation re-drains afterward — events are never silently dropped.
   */
  async readNewEvents(): Promise<void> {
    if (this.busy) {
      this.pendingRead = true
      return
    }
    this.busy = true
    try {
      await this._readNewEventsUnsafe()
      // Re-drain: events may have been written while we were busy.
      while (this.pendingRead) {
        this.pendingRead = false
        await this._readNewEventsUnsafe()
      }
    } finally {
      this.busy = false
    }
  }

  private async _readNewEventsUnsafe(): Promise<void> {
    try {
      const fileStat = await stat(this.eventsLog).catch(() => null)
      if (!fileStat) return

      // File shrank (rotation / external truncation) → reset.
      if (fileStat.size < this.readOffset) {
        this.readOffset = 0
        this.trailingLine = ''
      }

      const bytesToRead = fileStat.size - this.readOffset
      if (bytesToRead <= 0) return

      const fh = await open(this.eventsLog, 'r')
      try {
        const buf = Buffer.alloc(bytesToRead)
        await fh.read(buf, 0, bytesToRead, this.readOffset)
        this.readOffset = fileStat.size

        // Prepend any leftover from the previous read.
        const raw = this.trailingLine + buf.toString('utf-8')
        const lines = raw.split('\n')

        // The last element is either '' (line ended with \n) or a partial
        // line still being written by the shell. Stash it for next time.
        this.trailingLine = lines.pop() ?? ''

        let dispatched = 0
        let skipped = 0
        for (const line of lines) {
          const event = parseHookLogLine(line)
          if (event && !this.shouldSkip?.(event)) {
            this.dispatch({ type: 'hooks:event', payload: event })
            dispatched++
          } else if (event) {
            skipped++
          }
        }

        if (dispatched > 0 || skipped > 0) {
          log.debug('Processed events', { dispatched, skipped })
        }
      } finally {
        await fh.close()
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to read events log', { eventsLog: this.eventsLog }, err)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Startup cleanup
  // -----------------------------------------------------------------------

  /**
   * Clear events.jsonl after consuming its content on startup.
   *
   * Called once during {@link start}, AFTER {@link readNewEvents} has drained
   * the file. This maintains the invariant: consume first, then clear.
   *
   * Uses unlink + append-create (instead of writeFile → truncate) so that any
   * bytes the shell script writes between our read and this call are not
   * silently clobbered. The shell's `>>` will atomically re-create the file.
   */
  private async clearConsumedEvents(): Promise<void> {
    try {
      const fileStat = await stat(this.eventsLog).catch(() => null)
      if (!fileStat || fileStat.size === 0) return

      // Remove the old file. Shell script uses `>>` which atomically creates
      // the file if missing — any concurrent write lands in the new inode.
      await unlink(this.eventsLog)
      // Re-create so that fs.watch has a file to watch.
      const fh = await open(this.eventsLog, 'a')
      await fh.close()

      this.readOffset = 0
      this.trailingLine = ''
      log.info('Cleared consumed events on startup', { previousSize: fileStat.size })
    } catch (err) {
      log.warn('Failed to clear events on startup', { eventsLog: this.eventsLog }, err)
    }
  }

  // -----------------------------------------------------------------------
  // Size-based rotation
  // -----------------------------------------------------------------------

  private startRotationCheck(): void {
    this.rotationTimer = setInterval(() => {
      this.rotateIfNeeded().catch((err) =>
        log.warn('Rotation check failed', { eventsLog: this.eventsLog }, err)
      )
    }, ROTATION_CHECK_INTERVAL)
  }

  /**
   * Rotate the events log when it exceeds {@link MAX_FILE_SIZE}.
   *
   * Rotation scheme (matches platform/logger.ts):
   *   events.jsonl   → events.1.jsonl
   *   events.1.jsonl → events.2.jsonl
   *   …
   *   events.N.jsonl → dropped (overwritten)
   *
   * After rotation the active file is re-created with `open(path, 'a')` rather
   * than `writeFile(path, '')`. The append-create semantic means that if the
   * external shell script races and creates the file between our rename and our
   * open, its content is preserved instead of being silently truncated.
   */
  async rotateIfNeeded(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this._rotateIfNeededUnsafe()
    } finally {
      this.busy = false
    }
  }

  private async _rotateIfNeededUnsafe(): Promise<void> {
    try {
      const fileStat = await stat(this.eventsLog).catch(() => null)
      if (!fileStat || fileStat.size < MAX_FILE_SIZE) return

      // Drain remaining events before rotating.
      await this._readNewEventsUnsafe()

      // Cascade archives: .3 ← .2 ← .1 ← active
      const { dir, name, ext } = parsePath(this.eventsLog)
      for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
        const src = i === 1 ? this.eventsLog : join(dir, `${name}.${i - 1}${ext}`)
        const dst = join(dir, `${name}.${i}${ext}`)
        await rename(src, dst).catch(() => { /* source may not exist */ })
      }

      // Re-create the active file. Using append mode ('a') avoids clobbering
      // content that the shell script may have raced to write between our
      // rename() and this open().
      const fh = await open(this.eventsLog, 'a')
      await fh.close()

      this.readOffset = 0
      this.trailingLine = ''

      log.info('Events log rotated', { previousSize: fileStat.size })
    } catch (err) {
      log.warn('Events log rotation failed', { eventsLog: this.eventsLog }, err)
    }
  }
}
