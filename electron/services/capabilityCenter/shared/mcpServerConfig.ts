// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Server Config — single source of truth for MCP server configuration
 * type definitions, validation, extraction, and normalization.
 *
 * The Claude Agent SDK validates MCP server configs at startup using a strict
 * Zod union schema. Each config must match exactly one of the known transport
 * types. A single invalid config causes the SDK to exit with code 1, killing
 * the entire session.
 *
 * This module centralizes all MCP config knowledge so that:
 *   - Import pipeline can normalize configs correctly for all transport types
 *   - Session injector can validate before passing to the SDK
 *   - New transport types only require adding one entry to TRANSPORT_SPECS
 */

import { isPlainObject } from '@shared/typeGuards'

// ── Transport Specifications (declarative, single source of truth) ───────

/**
 * Specification for an MCP transport type.
 *
 * `requiredFields` lists fields that the SDK's Zod schema mandates for this
 * type. A config missing any of these will be rejected at startup.
 */
interface TransportSpec {
  readonly requiredFields: readonly string[]
}

/**
 * All transport types recognized by the Claude Agent SDK, with their
 * required field constraints.
 *
 * To add a new transport type, add a single entry here — all downstream
 * validation and normalization will pick it up automatically.
 */
const TRANSPORT_SPECS: Readonly<Record<string, TransportSpec>> = {
  stdio:              { requiredFields: ['command'] },
  sse:                { requiredFields: ['url'] },
  http:               { requiredFields: ['url'] },
  ws:                 { requiredFields: ['url'] },
  sdk:                { requiredFields: ['name'] },
  'sse-ide':          { requiredFields: ['url', 'ideName'] },
  'ws-ide':           { requiredFields: ['url', 'ideName'] },
  'claudeai-proxy':   { requiredFields: ['url', 'id'] },
}

// ── Validation ───────────────────────────────────────────────────────────

/** Result of validating a raw MCP server config. */
export type McpConfigValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string }

/**
 * Validate that a raw MCP server config satisfies the Claude Agent SDK's
 * Zod schema requirements.
 *
 * This is a pure function — it does not log or throw. The caller decides
 * how to handle invalid configs (log + skip, throw, etc.).
 */
export function validateMcpConfig(raw: Record<string, unknown>): McpConfigValidationResult {
  const type = raw['type']

  // Reject non-string type values early with a precise error message.
  if (type !== undefined && typeof type !== 'string') {
    return { valid: false, reason: `"type" field must be a string, got ${typeof type}` }
  }

  // No explicit type → SDK treats as stdio (type field is optional for stdio)
  if (type === undefined || type === 'stdio') {
    const command = raw['command']
    if (typeof command !== 'string' || command.length === 0) {
      return { valid: false, reason: 'stdio type requires a non-empty "command" field' }
    }
  } else {
    const spec = TRANSPORT_SPECS[type]
    if (!spec) {
      return { valid: false, reason: `unknown transport type "${type}"` }
    }

    for (const field of spec.requiredFields) {
      const value = raw[field]
      if (value === undefined || value === null || value === '') {
        return { valid: false, reason: `type "${type}" requires a non-empty "${field}" field` }
      }
    }
  }

  // Validate optional fields whose types the SDK's Zod schema enforces strictly.
  // A mismatch here (e.g., args: [null]) causes a fatal exit code 1 at startup.
  const fieldTypeResult = validateOptionalFieldTypes(raw)
  if (!fieldTypeResult.valid) return fieldTypeResult

  return { valid: true }
}

/**
 * Validate types of optional fields that the SDK's Zod schema enforces.
 *
 * The SDK schemas define:
 *   - `args: z.array(z.string())`
 *   - `env: z.record(z.string(), z.string())`
 *   - `headers: z.record(z.string(), z.string())`
 *
 * A value like `args: [null]` passes required-field checks but fails the
 * Zod union, causing a fatal exit. This function catches such mismatches
 * before they reach the SDK.
 */
function validateOptionalFieldTypes(raw: Record<string, unknown>): McpConfigValidationResult {
  const args = raw['args']
  if (args !== undefined && args !== null) {
    if (!Array.isArray(args)) {
      return { valid: false, reason: '"args" must be an array of strings' }
    }
    if (args.some((item) => typeof item !== 'string')) {
      return { valid: false, reason: '"args" array contains non-string elements' }
    }
  }

  // The SDK enforces `env` and `headers` as Record<string, string>.
  for (const field of ['env', 'headers'] as const) {
    const value = raw[field]
    if (value === undefined || value === null) continue
    if (!isPlainObject(value)) {
      return { valid: false, reason: `"${field}" must be a Record<string, string>` }
    }
    if (Object.values(value).some((v) => typeof v !== 'string')) {
      return { valid: false, reason: `"${field}" contains non-string values` }
    }
  }

  return { valid: true }
}

// ── Extraction (stored config → SDK-ready config) ────────────────────────

/**
 * Extract the SDK-ready server config from a stored capability config.
 *
 * Stored configs use the canonical format `{ name, serverConfig: { ... } }`.
 * This function handles both:
 *   - Canonical: extracts `config.serverConfig`
 *   - Legacy/flat: uses `config` itself (when no `serverConfig` wrapper)
 *
 * Returns `null` if the extracted value is not a plain object.
 */
export function extractSdkConfig(storedConfig: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = storedConfig['serverConfig'] ?? storedConfig
  if (!isPlainObject(candidate)) return null
  return candidate
}

// ── Normalization (raw config → clean storage format) ────────────────────

/**
 * Normalize a raw MCP server config for storage.
 *
 * Preserves all non-empty fields regardless of transport type. This ensures
 * non-stdio servers (SSE, HTTP, WS, etc.) retain their `url`, `headers`,
 * and other essential fields.
 *
 * Empty arrays and empty objects are stripped to keep storage lean.
 */
export function normalizeForStorage(raw: Record<string, unknown>): Record<string, unknown> {
  const rawType = raw['type']
  const type = (typeof rawType === 'string' ? rawType : undefined) ?? 'stdio'
  const result: Record<string, unknown> = { type }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'type') continue
    if (value === undefined || value === null) continue

    // Deep-clean string arrays (args) — filter non-string elements.
    // The SDK's Zod schema requires `args: z.array(z.string())`.
    // A single null in args causes a fatal exit code 1 at startup.
    if (Array.isArray(value)) {
      const cleaned = value.filter((item): item is string => typeof item === 'string')
      if (cleaned.length === 0) continue
      result[key] = cleaned
      continue
    }

    // Preserve non-empty objects as-is. We intentionally do NOT deep-clean
    // objects because some (like `oauth`) contain non-string values that
    // are valid per the SDK schema. Type validation for specific fields
    // (env, headers) is handled by validateMcpConfig() instead.
    if (isPlainObject(value) && Object.keys(value).length === 0) continue

    result[key] = value
  }

  return result
}
