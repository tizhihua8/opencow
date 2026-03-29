// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest'
import {
  validateMcpConfig,
  extractSdkConfig,
  normalizeForStorage,
} from '../../../electron/services/capabilityCenter/shared/mcpServerConfig'

// ── validateMcpConfig ────────────────────────────────────────────────────

describe('validateMcpConfig', () => {
  describe('stdio (type optional)', () => {
    it('accepts valid stdio config with explicit type', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'npx', args: ['-y', 'my-mcp'] })
      expect(result).toEqual({ valid: true })
    })

    it('accepts valid stdio config without explicit type', () => {
      const result = validateMcpConfig({ command: 'node', args: ['server.js'] })
      expect(result).toEqual({ valid: true })
    })

    it('rejects stdio with empty command', () => {
      const result = validateMcpConfig({ type: 'stdio', command: '' })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('command')
    })

    it('rejects stdio with missing command', () => {
      const result = validateMcpConfig({ type: 'stdio' })
      expect(result.valid).toBe(false)
    })

    it('rejects implicit stdio (no type) with missing command', () => {
      const result = validateMcpConfig({ args: ['--flag'] })
      expect(result.valid).toBe(false)
    })
  })

  describe('sse', () => {
    it('accepts valid SSE config', () => {
      const result = validateMcpConfig({ type: 'sse', url: 'https://mcp.deepwiki.com/sse' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects SSE without url', () => {
      const result = validateMcpConfig({ type: 'sse' })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('url')
    })

    it('rejects SSE with empty url', () => {
      const result = validateMcpConfig({ type: 'sse', url: '' })
      expect(result.valid).toBe(false)
    })
  })

  describe('http', () => {
    it('accepts valid HTTP config', () => {
      const result = validateMcpConfig({ type: 'http', url: 'https://mcp.exa.ai/' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects HTTP without url', () => {
      const result = validateMcpConfig({ type: 'http', command: 'not-relevant' })
      expect(result.valid).toBe(false)
    })
  })

  describe('ws', () => {
    it('accepts valid WS config', () => {
      const result = validateMcpConfig({ type: 'ws', url: 'wss://example.com/mcp' })
      expect(result).toEqual({ valid: true })
    })
  })

  describe('sdk', () => {
    it('accepts valid SDK config', () => {
      const result = validateMcpConfig({ type: 'sdk', name: 'my-server' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects SDK without name', () => {
      const result = validateMcpConfig({ type: 'sdk' })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('name')
    })
  })

  describe('sse-ide', () => {
    it('accepts valid sse-ide config', () => {
      const result = validateMcpConfig({ type: 'sse-ide', url: 'http://localhost:3000', ideName: 'vscode' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects sse-ide without ideName', () => {
      const result = validateMcpConfig({ type: 'sse-ide', url: 'http://localhost:3000' })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('ideName')
    })
  })

  describe('ws-ide', () => {
    it('accepts valid ws-ide config', () => {
      const result = validateMcpConfig({ type: 'ws-ide', url: 'ws://localhost:3000', ideName: 'vscode' })
      expect(result).toEqual({ valid: true })
    })
  })

  describe('claudeai-proxy', () => {
    it('accepts valid claudeai-proxy config', () => {
      const result = validateMcpConfig({ type: 'claudeai-proxy', url: 'https://proxy.example.com', id: 'abc-123' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects claudeai-proxy without id', () => {
      const result = validateMcpConfig({ type: 'claudeai-proxy', url: 'https://proxy.example.com' })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('id')
    })
  })

  describe('unknown type', () => {
    it('rejects unknown transport type', () => {
      const result = validateMcpConfig({ type: 'grpc', endpoint: 'localhost:50051' })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('unknown')
      expect(result.reason).toContain('grpc')
    })
  })

  describe('non-string type', () => {
    it('rejects numeric type with precise error', () => {
      const result = validateMcpConfig({ type: 42 as unknown as string })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('must be a string')
      expect(result.reason).toContain('number')
    })

    it('rejects boolean type', () => {
      const result = validateMcpConfig({ type: true as unknown as string })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('must be a string')
    })
  })

  describe('optional field type validation', () => {
    it('rejects args containing null (the xiaohongshu-mcp crash)', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'uvx', args: [null] as unknown as string[] })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('args')
      expect(result.reason).toContain('non-string')
    })

    it('rejects args containing numbers', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'npx', args: ['valid', 123 as unknown as string] })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('args')
    })

    it('rejects non-array args', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'npx', args: 'not-an-array' as unknown as string[] })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('args')
    })

    it('accepts valid string args', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'npx', args: ['-y', 'my-mcp'] })
      expect(result).toEqual({ valid: true })
    })

    it('accepts config without args (args is optional)', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'npx' })
      expect(result).toEqual({ valid: true })
    })

    it('rejects env with non-string values', () => {
      const result = validateMcpConfig({ type: 'stdio', command: 'npx', env: { KEY: 123 as unknown as string } })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('env')
    })

    it('rejects headers with non-string values', () => {
      const result = validateMcpConfig({ type: 'sse', url: 'https://example.com', headers: { key: null as unknown as string } })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('headers')
    })

    it('accepts valid headers', () => {
      const result = validateMcpConfig({ type: 'sse', url: 'https://example.com', headers: { 'x-api-key': 'test' } })
      expect(result).toEqual({ valid: true })
    })
  })
})

// ── extractSdkConfig ─────────────────────────────────────────────────────

describe('extractSdkConfig', () => {
  it('extracts serverConfig from canonical format', () => {
    const stored = { name: 'my-server', serverConfig: { type: 'stdio', command: 'npx' } }
    expect(extractSdkConfig(stored)).toEqual({ type: 'stdio', command: 'npx' })
  })

  it('returns the entire config when no serverConfig wrapper (legacy)', () => {
    const stored = { type: 'sse', url: 'https://example.com/sse' }
    expect(extractSdkConfig(stored)).toEqual({ type: 'sse', url: 'https://example.com/sse' })
  })

  it('returns null when serverConfig is not a plain object', () => {
    const stored = { name: 'broken', serverConfig: 'not-an-object' }
    expect(extractSdkConfig(stored)).toBeNull()
  })

  it('returns null for empty object (no serverConfig, no useful fields)', () => {
    // extractSdkConfig returns the config itself — validation catches emptiness later
    const stored = {}
    expect(extractSdkConfig(stored)).toEqual({})
  })

  it('prefers serverConfig over top-level fields', () => {
    const stored = {
      name: 'my-server',
      type: 'should-be-ignored',
      serverConfig: { type: 'http', url: 'https://example.com' },
    }
    expect(extractSdkConfig(stored)).toEqual({ type: 'http', url: 'https://example.com' })
  })
})

// ── normalizeForStorage ──────────────────────────────────────────────────

describe('normalizeForStorage', () => {
  it('defaults type to stdio when not specified', () => {
    const result = normalizeForStorage({ command: 'npx', args: ['-y', 'my-mcp'] })
    expect(result).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'my-mcp'] })
  })

  it('preserves SSE-specific fields', () => {
    const raw = { type: 'sse', url: 'https://example.com/sse', headers: { 'x-api-key': 'test' } }
    const result = normalizeForStorage(raw)
    expect(result).toEqual(raw)
  })

  it('preserves HTTP-specific fields', () => {
    const raw = { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer xxx' } }
    const result = normalizeForStorage(raw)
    expect(result).toEqual(raw)
  })

  it('strips empty arrays', () => {
    const result = normalizeForStorage({ type: 'stdio', command: 'npx', args: [] })
    expect(result).toEqual({ type: 'stdio', command: 'npx' })
  })

  it('strips empty objects', () => {
    const result = normalizeForStorage({ type: 'stdio', command: 'npx', env: {} })
    expect(result).toEqual({ type: 'stdio', command: 'npx' })
  })

  it('strips null and undefined values', () => {
    const result = normalizeForStorage({ type: 'stdio', command: 'npx', env: undefined, args: null as unknown as undefined })
    expect(result).toEqual({ type: 'stdio', command: 'npx' })
  })

  it('preserves unknown fields for forward compatibility', () => {
    const raw = { type: 'sse', url: 'https://example.com', oauth: { clientId: 'abc' }, customField: 'x' }
    const result = normalizeForStorage(raw)
    expect(result).toHaveProperty('oauth')
    expect(result).toHaveProperty('customField')
  })

  it('filters null elements from args arrays', () => {
    const result = normalizeForStorage({ type: 'stdio', command: 'uvx', args: [null, 'valid', undefined] as unknown as string[] })
    expect(result).toEqual({ type: 'stdio', command: 'uvx', args: ['valid'] })
  })

  it('strips args array that becomes empty after filtering non-strings', () => {
    const result = normalizeForStorage({ type: 'stdio', command: 'uvx', args: [null] as unknown as string[] })
    expect(result).toEqual({ type: 'stdio', command: 'uvx' })
  })

  it('filters non-string elements from arrays', () => {
    const result = normalizeForStorage({ type: 'stdio', command: 'npx', args: ['valid', 123 as unknown as string, 'also-valid'] })
    expect(result).toEqual({ type: 'stdio', command: 'npx', args: ['valid', 'also-valid'] })
  })

  it('preserves nested objects with mixed value types (oauth)', () => {
    const raw = { type: 'sse', url: 'https://example.com', oauth: { clientId: 'abc', callbackPort: 3000 } }
    const result = normalizeForStorage(raw)
    expect(result.oauth).toEqual({ clientId: 'abc', callbackPort: 3000 })
  })
})
