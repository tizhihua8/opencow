// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest'
import { prepareExtractionContent, buildSummarizationPrompt } from '../../../electron/memory/contentPreparer'

// ─── Helpers ─────────────────────────────────────────────────────────

function msg(role: string, text: string) {
  return { role, content: [{ type: 'text' as const, text }] }
}

function toolMsg(role: string) {
  return { role, content: [{ type: 'tool_use' as const, id: '1', name: 'bash', input: {} }] }
}

function longText(chars: number): string {
  return 'x'.repeat(chars)
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('prepareExtractionContent', () => {
  describe('basic extraction', () => {
    it('returns null for empty messages', () => {
      expect(prepareExtractionContent([], 12000)).toBeNull()
    })

    it('returns null for content shorter than 30 chars', () => {
      const messages = [msg('user', 'hi')]
      expect(prepareExtractionContent(messages, 12000)).toBeNull()
    })

    it('extracts user and assistant text blocks', () => {
      const messages = [
        msg('user', 'I am a backend developer with 10 years of Go experience'),
        msg('assistant', 'Great! How can I help you today?'),
      ]
      const result = prepareExtractionContent(messages, 12000)
      expect(result).toContain('User: I am a backend developer')
      expect(result).toContain('Assistant: Great!')
    })

    it('excludes system and tool messages', () => {
      const messages = [
        msg('system', 'You are a helpful assistant'),
        msg('user', 'Help me write a function that calculates fibonacci numbers'),
        toolMsg('assistant'),
        msg('assistant', 'Here is the implementation'),
      ]
      const result = prepareExtractionContent(messages, 12000)
      expect(result).not.toContain('system')
      expect(result).not.toContain('tool_use')
      expect(result).toContain('User: Help me write')
      expect(result).toContain('Assistant: Here is')
    })

    it('excludes tool_use and tool_result content blocks', () => {
      const messages = [
        {
          role: 'user',
          content: [{ type: 'text' as const, text: 'Read the file please' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text' as const, text: 'Let me read that file.' },
            { type: 'tool_use' as const, id: '1', name: 'read', input: { path: '/foo' } },
          ],
        },
      ]
      const result = prepareExtractionContent(messages, 12000)
      expect(result).toContain('User: Read the file')
      expect(result).toContain('Assistant: Let me read')
      expect(result).not.toContain('/foo')
    })
  })

  describe('short conversations — full preservation', () => {
    it('preserves all content when within budget', () => {
      const messages = [
        msg('user', 'I prefer minimalist design'),
        msg('assistant', 'Understood, I will keep things clean and simple.'),
        msg('user', 'Also I use TypeScript strict mode'),
        msg('assistant', 'Noted. I will ensure strict type checking.'),
      ]
      const result = prepareExtractionContent(messages, 12000)!
      expect(result).toContain('I prefer minimalist design')
      expect(result).toContain('Understood, I will keep things clean')
      expect(result).toContain('Also I use TypeScript strict mode')
      expect(result).toContain('Noted. I will ensure strict')
    })
  })

  describe('long conversations — recent-turns-first compression', () => {
    it('preserves latest 2 turns fully and truncates older assistant messages', () => {
      const messages = [
        // Turn 1 (oldest) — assistant should be truncated
        msg('user', 'I am a backend developer'),
        msg('assistant', longText(500)),
        // Turn 2 — assistant should be truncated
        msg('user', 'I prefer Go over Java'),
        msg('assistant', longText(500)),
        // Turn 3 (second newest) — fully preserved
        msg('user', 'This project uses monorepo'),
        msg('assistant', longText(500)),
        // Turn 4 (newest) — fully preserved
        msg('user', 'I agree with your directory structure'),
        msg('assistant', longText(500)),
      ]

      // Budget that forces compression (full text ~2200, budget ~1500)
      const result = prepareExtractionContent(messages, 1500)!

      // All user messages preserved in full
      expect(result).toContain('User: I am a backend developer')
      expect(result).toContain('User: I prefer Go over Java')
      expect(result).toContain('User: This project uses monorepo')
      expect(result).toContain('User: I agree with your directory structure')

      // Latest 2 turns: assistant text should contain full 500-char content
      const assistantEntries = result.split('\n').filter(l => l.startsWith('Assistant: '))
      const lastTwo = assistantEntries.slice(-2)
      // Full text = "Assistant: " (11 chars) + 500 x's = 511 chars per line
      for (const line of lastTwo) {
        expect(line.length).toBeGreaterThan(400) // full 500 chars + prefix
      }

      // Older turns: assistant truncated to ~200 chars + "…"
      const olderTwo = assistantEntries.slice(0, 2)
      for (const line of olderTwo) {
        expect(line.length).toBeLessThanOrEqual(215) // "Assistant: " + 200 + "…"
        expect(line).toContain('…')
      }
    })

    it('user messages are preserved in compressed output even when long', () => {
      const longUserContent = 'My background: ' + longText(300)
      const messages = [
        msg('user', longUserContent),
        msg('assistant', longText(500)),
        msg('user', 'Short follow-up question about the project structure'),
        msg('assistant', 'Here is the answer with details.'),
      ]

      // Budget larger than compressed output so we can verify user content
      const result = prepareExtractionContent(messages, 2000)!
      expect(result).toContain(`User: ${longUserContent}`)
      expect(result).toContain('User: Short follow-up')
    })
  })

  describe('turn grouping', () => {
    it('handles multiple consecutive assistant messages in one turn', () => {
      const messages = [
        msg('user', 'Explain this code'),
        msg('assistant', 'First part of explanation'),
        msg('assistant', 'Second part of explanation'),
      ]
      const result = prepareExtractionContent(messages, 12000)!
      expect(result).toContain('First part')
      expect(result).toContain('Second part')
    })

    it('handles user message without assistant response', () => {
      const messages = [
        msg('user', 'I am a senior engineer with 15 years of experience'),
      ]
      const result = prepareExtractionContent(messages, 12000)!
      expect(result).toContain('User: I am a senior engineer')
      expect(result).not.toContain('Assistant:')
    })

    it('handles assistant-only messages (no preceding user) gracefully', () => {
      const messages = [
        msg('assistant', 'Welcome! How can I help?'),
        msg('user', 'Tell me about this project setup'),
        msg('assistant', 'This is a monorepo...'),
      ]
      const result = prepareExtractionContent(messages, 12000)!
      // The orphan assistant message is skipped (no user message to start the turn)
      expect(result).toContain('User: Tell me about')
      expect(result).toContain('Assistant: This is a monorepo')
    })
  })
})

describe('buildSummarizationPrompt', () => {
  it('includes conversation text in the prompt', () => {
    const text = 'User: I like Go\nAssistant: Great choice!'
    const prompt = buildSummarizationPrompt(text)
    expect(prompt).toContain('User: I like Go')
    expect(prompt).toContain('Great choice!')
  })

  it('includes preservation instructions', () => {
    const prompt = buildSummarizationPrompt('test')
    expect(prompt).toContain('personal background')
    expect(prompt).toContain('preferences')
    expect(prompt).toContain('behavioral patterns')
    expect(prompt).toContain('Project decisions')
    expect(prompt).toContain('agreed with or rejected')
  })
})
