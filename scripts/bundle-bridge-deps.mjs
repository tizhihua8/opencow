#!/usr/bin/env node

/**
 * Bundle external dependencies that are required at runtime by child processes
 * spawned from the packaged Electron app.
 *
 * Problem: child processes (spawned via child_process.spawn) cannot read from
 * Electron's virtual app.asar filesystem. Any `require()` call for a module
 * inside the asar will fail with MODULE_NOT_FOUND.
 *
 * Solution: pre-bundle these dependencies into real files shipped via
 * extraResources, so child processes can resolve them from the filesystem.
 *
 * Two bundles are produced:
 *
 * 1. codex-bridge-deps.cjs
 *    Single CJS file exporting McpServer, StdioServerTransport, and z.
 *    Used by the codex native bridge stdio script.
 *
 * 2. sdk-externals/
 *    Directory tree mirroring node_modules layout for modules that cli.js
 *    (the Claude Agent SDK) requires at runtime via bare specifiers.
 *    Made available to the child process via NODE_PATH.
 */

import { build } from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const resourcesDir = path.join(projectRoot, 'resources')

// ── 1. Codex bridge deps bundle ─────────────────────────────────────────────

const bridgeDepsOut = path.join(resourcesDir, 'codex-bridge-deps.cjs')

const bridgeDepsEntry = `
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod/v4');

module.exports = { McpServer, StdioServerTransport, z };
`

await build({
  stdin: {
    contents: bridgeDepsEntry,
    resolveDir: projectRoot,
    loader: 'js',
  },
  outfile: bridgeDepsOut,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
})

console.log(`[bundle-bridge-deps] wrote ${bridgeDepsOut}`)

// ── 2. SDK external modules ─────────────────────────────────────────────────
//
// cli.js from @anthropic-ai/claude-agent-sdk has these bare require() calls
// that are NOT bundled into cli.js itself:
//
//   require("ajv/dist/runtime/equal")
//   require("ajv/dist/runtime/ucs2length")
//   require("ajv/dist/runtime/uri")
//   require("ajv/dist/runtime/validation_error")
//   require("ajv-formats/dist/formats")
//
// We bundle each into its expected path under sdk-externals/ so that setting
// NODE_PATH=<sdk-externals> allows the child process to resolve them.

const sdkExternalsDir = path.join(resourcesDir, 'sdk-externals')

const sdkExternalEntries = [
  { specifier: 'ajv/dist/runtime/equal', outPath: 'ajv/dist/runtime/equal.js' },
  { specifier: 'ajv/dist/runtime/ucs2length', outPath: 'ajv/dist/runtime/ucs2length.js' },
  { specifier: 'ajv/dist/runtime/uri', outPath: 'ajv/dist/runtime/uri.js' },
  { specifier: 'ajv/dist/runtime/validation_error', outPath: 'ajv/dist/runtime/validation_error.js' },
  { specifier: 'ajv-formats/dist/formats', outPath: 'ajv-formats/dist/formats.js' },
]

for (const entry of sdkExternalEntries) {
  const outfile = path.join(sdkExternalsDir, entry.outPath)
  fs.mkdirSync(path.dirname(outfile), { recursive: true })

  await build({
    stdin: {
      contents: `module.exports = require(${JSON.stringify(entry.specifier)});`,
      resolveDir: projectRoot,
      loader: 'js',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
  })
}

console.log(`[bundle-bridge-deps] wrote ${sdkExternalEntries.length} sdk-externals`)
