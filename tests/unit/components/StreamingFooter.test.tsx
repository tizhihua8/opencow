// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { StreamingFooter } from '../../../src/renderer/components/DetailPanel/SessionPanel/StreamingFooter'

describe('StreamingFooter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders ASCII sparkle spinner and a status verb', () => {
    render(
      <StreamingFooter activeDurationMs={10_000} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByTestId('sparkle-spinner')).toBeInTheDocument()
    expect(screen.getByTestId('sparkle-spinner').className).toContain('sparkle-spinner')
    // Should show one of the status verbs followed by …
    expect(screen.getByRole('status').textContent).toMatch(/\w+\u2026/)
  })

  it('displays formatted elapsed time in seconds', () => {
    render(
      <StreamingFooter activeDurationMs={39_000} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    expect(screen.getByText(/39s/)).toBeInTheDocument()
  })

  it('displays formatted elapsed time in minutes and seconds', () => {
    render(
      <StreamingFooter activeDurationMs={133_000} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    expect(screen.getByText(/2m 13s/)).toBeInTheDocument()
  })

  it('hides token count when total is 0', () => {
    render(
      <StreamingFooter activeDurationMs={0} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    expect(screen.queryByText(/tokens/)).toBeNull()
  })

  it('displays token count when > 0 (small number)', () => {
    render(
      <StreamingFooter activeDurationMs={0} activeStartedAt={null} inputTokens={500} outputTokens={200} activity={null} todos={null} />
    )
    expect(screen.getByText(/700 tokens/)).toBeInTheDocument()
  })

  it('displays token count with k suffix for >= 1000', () => {
    render(
      <StreamingFooter activeDurationMs={0} activeStartedAt={null} inputTokens={800} outputTokens={400} activity={null} todos={null} />
    )
    expect(screen.getByText(/1.2k tokens/)).toBeInTheDocument()
  })

  it('has accessible aria-label with streaming info', () => {
    render(
      <StreamingFooter activeDurationMs={5_000} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-label', expect.stringContaining('Streaming'))
  })

  it('has muted background for fixed footer appearance', () => {
    render(
      <StreamingFooter activeDurationMs={0} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    const el = screen.getByRole('status')
    expect(el.className).toContain('bg-')
    expect(el.className).toContain('border-t')
  })

  it('rotates status text after interval', () => {
    // Seed with known index by mocking Math.random
    vi.spyOn(Math, 'random').mockReturnValue(0) // index 0 = "Reasoning"
    render(
      <StreamingFooter activeDurationMs={0} activeStartedAt={null} inputTokens={0} outputTokens={0} activity={null} todos={null} />
    )
    expect(screen.getByText(/Reasoning\u2026/)).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.getByText(/Thinking\u2026/)).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.getByText(/Working\u2026/)).toBeInTheDocument()

    vi.spyOn(Math, 'random').mockRestore()
  })

  it('displays activity indicator when provided', () => {
    render(
      <StreamingFooter activeDurationMs={10_000} activeStartedAt={null} inputTokens={500} outputTokens={200} activity="thinking" todos={null} />
    )
    expect(screen.getByText(/thinking/)).toBeInTheDocument()
  })

  it('hides activity indicator when null', () => {
    render(
      <StreamingFooter activeDurationMs={0} activeStartedAt={null} inputTokens={500} outputTokens={200} activity={null} todos={null} />
    )
    // Should show tokens but NOT any activity text beyond the rotating status verb
    expect(screen.getByText(/700 tokens/)).toBeInTheDocument()
    expect(screen.queryByText(/thinking/)).toBeNull()
  })

  it('displays tool name as activity', () => {
    render(
      <StreamingFooter activeDurationMs={42_000} activeStartedAt={null} inputTokens={300} outputTokens={407} activity="Read" todos={null} />
    )
    expect(screen.getByText(/Read/)).toBeInTheDocument()
    expect(screen.getByText(/42s/)).toBeInTheDocument()
  })

  it('includes activity in aria-label', () => {
    render(
      <StreamingFooter activeDurationMs={5_000} activeStartedAt={null} inputTokens={0} outputTokens={0} activity="thinking" todos={null} />
    )
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-label', expect.stringContaining('thinking'))
  })

  it('displays full format: spinner + verb + time + tokens + activity', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // "Reasoning"
    render(
      <StreamingFooter activeDurationMs={42_000} activeStartedAt={null} inputTokens={400} outputTokens={307} activity="thinking" todos={null} />
    )
    const content = screen.getByRole('status').textContent ?? ''
    // Format: ✦ Reasoning… (42s · ↓ 707 tokens · thinking)
    expect(content).toContain('Reasoning\u2026')
    expect(content).toContain('42s')
    expect(content).toContain('707 tokens')
    expect(content).toContain('thinking')
    vi.spyOn(Math, 'random').mockRestore()
  })
})
