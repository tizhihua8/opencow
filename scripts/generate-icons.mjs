#!/usr/bin/env node

/**
 * generate-icons.mjs
 *
 * Single Source of Truth icon pipeline.
 * Generates ALL icon variants from source images:
 *   - resources/logo-source.png     → production icons
 *   - resources/logo-source-dev.png → dev build icons (dark background for visual distinction)
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 *
 * Prerequisites (macOS):
 *   - sips (built-in)
 *   - iconutil (built-in)
 *   - python3 + Pillow (`pip3 install Pillow`)
 *
 * Generated outputs:
 *   resources/icon.icns        — macOS .app bundle icon (full-bleed, system applies squircle mask)
 *   resources/icon.png         — BrowserWindow / dev Dock icon (pre-masked squircle + padding)
 *   resources/icon-dev.icns    — dev build .icns (full-bleed, dark bg, from logo-source-dev.png)
 *   resources/icon-dev.png     — dev Dock icon (pre-masked squircle, dark bg)
 *   resources/tray.png         — menu bar tray icon 22×22 (colored, cropped)
 *   resources/tray@2x.png      — menu bar tray icon 44×44 (colored, cropped, Retina)
 *
 * NOTE: .icns files are full-bleed — macOS applies squircle mask automatically for
 * bundle icons. .png files have a pre-rendered squircle mask because Electron's
 * app.dock.setIcon() and BrowserWindow icon do NOT get system masking.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')
const RESOURCES = join(ROOT, 'resources')
const SOURCE = join(RESOURCES, 'logo-source.png')
const SOURCE_DEV = join(RESOURCES, 'logo-source-dev.png')
const TMP = join(ROOT, '.tmp-icons')

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  execSync(cmd, { stdio: 'pipe' })
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function cleanDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

// ── Validation ───────────────────────────────────────────────────────────────

if (!existsSync(SOURCE)) {
  console.error(`❌ Source image not found: ${SOURCE}`)
  console.error('   Place the master logo at resources/logo-source.png')
  process.exit(1)
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('🎨 Generating icon variants from resources/logo-source.png\n')

cleanDir(TMP)
ensureDir(TMP)

// Step 1: Write Python script to temp file and execute
const pyScript = join(TMP, 'gen.py')
writeFileSync(pyScript, `
import sys, os
from PIL import Image, ImageDraw, ImageFilter

src_path = sys.argv[1]
tmp_dir  = sys.argv[2]
res_dir  = sys.argv[3]

src = Image.open(src_path).convert("RGBA")

# ── Crop to content bounding box ──
def get_bbox(img, threshold=30):
    px = img.load()
    w, h = img.size
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > threshold:
                x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
    return (x0, y0, x1 + 1, y1 + 1)

bbox = get_bbox(src)
sz = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
cx, cy = (bbox[0] + bbox[2]) // 2, (bbox[1] + bbox[3]) // 2
half = sz // 2
crop = src.crop((max(0, cx-half), max(0, cy-half),
                 min(src.size[0], cx+half), min(src.size[1], cy+half)))
if crop.size[0] != crop.size[1]:
    s = max(crop.size)
    c = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    c.paste(crop, ((s - crop.size[0]) // 2, (s - crop.size[1]) // 2))
    crop = c

CANVAS = 1024

# ── macOS squircle mask (continuous-curvature rounded rect) ──
# Apple's icon grid: 824×824 shape centered in 1024×1024 canvas (~100px margin).
# The squircle radius is ~185px on the 824 shape.
# We approximate the system squircle with a high-quality rounded rectangle.
SHAPE = 824
MARGIN = (CANVAS - SHAPE) // 2
SHAPE_RADIUS = 185

def make_squircle_mask():
    """Create a macOS-style squircle alpha mask on a 1024×1024 canvas."""
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, MARGIN + SHAPE, MARGIN + SHAPE],
        radius=SHAPE_RADIUS, fill=255)
    return mask

def make_full_bleed(content, bg_color):
    """Create a full-bleed 1024×1024 icon (for .icns, system applies mask).
    Apple icon grid: content sits within ~18% padding of the canvas,
    so the main visual occupies ~64% of the total area — matching the
    proportions of first-party macOS icons (Finder, Safari, etc.)."""
    icon = Image.new("RGBA", (CANVAS, CANVAS), bg_color)
    CONTENT_PAD = int(CANVAS * 0.18)
    CONTENT_SIZE = CANVAS - CONTENT_PAD * 2
    resized = content.resize((CONTENT_SIZE, CONTENT_SIZE), Image.LANCZOS)
    icon.paste(resized, (CONTENT_PAD, CONTENT_PAD), resized)
    return icon

def make_masked_png(full_bleed_icon):
    """Apply squircle mask to a full-bleed icon (for .png used by app.dock.setIcon)."""
    mask = make_squircle_mask()
    result = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    result.paste(full_bleed_icon, (0, 0), mask)
    return result

# 1. Production icon — white background
full_bleed = make_full_bleed(crop, (255, 255, 255, 255))
full_bleed.save(os.path.join(tmp_dir, "icon-full-bleed.png"))  # for .icns
make_masked_png(full_bleed).save(os.path.join(res_dir, "icon.png"))
print("  ✓ icon.png (squircle-masked, white bg, for dock/BrowserWindow)")

# 2. Dev icon — dark background, separate source
dev_src_path = sys.argv[4] if len(sys.argv) > 4 else None
if dev_src_path and os.path.exists(dev_src_path):
    dev_src = Image.open(dev_src_path).convert("RGBA")
    dev_full = dev_src.resize((CANVAS, CANVAS), Image.LANCZOS)
else:
    dev_full = full_bleed
    print("    (no dev source found, using production icon as fallback)")
dev_full.save(os.path.join(tmp_dir, "icon-dev-full-bleed.png"))  # for .icns
make_masked_png(dev_full).save(os.path.join(res_dir, "icon-dev.png"))
print("  ✓ icon-dev.png (squircle-masked, dark bg, for dev dock)")

# 3. tray.png / tray@2x.png — Colored menu bar icon
TRAY_PADDING_RATIO = 0.15
tray_sz = int(sz * (1 + TRAY_PADDING_RATIO * 2))
tray_canvas = Image.new("RGBA", (tray_sz, tray_sz), (0, 0, 0, 0))
offset = int(tray_sz * TRAY_PADDING_RATIO)
tray_canvas.paste(crop, (offset, offset), crop)
tray_canvas.resize((44, 44), Image.LANCZOS).save(os.path.join(res_dir, "tray@2x.png"))
tray_canvas.resize((22, 22), Image.LANCZOS).save(os.path.join(res_dir, "tray.png"))
print("  ✓ tray.png (22×22), tray@2x.png (44×44)")

print("\\n✅ All icon variants generated")
`)

try {
  const result = execSync(
    `python3 "${pyScript}" "${SOURCE}" "${TMP}" "${RESOURCES}" "${SOURCE_DEV}"`,
    { encoding: 'utf-8' },
  )
  console.log(result)
} catch (e) {
  console.error('❌ Python/Pillow failed. Ensure python3 and Pillow are installed.')
  console.error(e.stderr || e.message)
  process.exit(1)
}

// Step 2: Generate .icns from icon.png (full-bleed) using macOS native tools
console.log('🔨 Building .icns with sips + iconutil\n')

const iconsetDir = join(TMP, 'icon.iconset')
ensureDir(iconsetDir)

// Use the full-bleed intermediate (not the masked .png) as the .icns source.
// macOS 11+ automatically applies a squircle mask and drop shadow to bundle icons.
const icnsSrc = join(TMP, 'icon-full-bleed.png')
const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

for (const [name, size] of sizes) {
  run(`sips -z ${size} ${size} "${icnsSrc}" --out "${join(iconsetDir, name)}"`)
}
console.log('  ✓ iconset created (10 sizes)')

run(`iconutil -c icns "${iconsetDir}" -o "${join(RESOURCES, 'icon.icns')}"`)
console.log('  ✓ icon.icns')

// Build icon-dev.icns from icon-dev.png (separate source, dark background)
const devIconsetDir = join(TMP, 'icon-dev.iconset')
ensureDir(devIconsetDir)
const icnsDevSrc = join(TMP, 'icon-dev-full-bleed.png')

for (const [name, size] of sizes) {
  run(`sips -z ${size} ${size} "${icnsDevSrc}" --out "${join(devIconsetDir, name)}"`)
}
run(`iconutil -c icns "${devIconsetDir}" -o "${join(RESOURCES, 'icon-dev.icns')}"`)
console.log('  ✓ icon-dev.icns\n')

// Cleanup
cleanDir(TMP)

console.log('✅ Done! All icons generated from single source.\n')
console.log('Files updated:')
console.log('  resources/icon.icns        (macOS bundle — full-bleed, system applies mask)')
console.log('  resources/icon-dev.icns    (dev macOS bundle, dark bg)')
console.log('  resources/icon.png         (squircle-masked, white bg)')
console.log('  resources/icon-dev.png     (squircle-masked, dark bg)')
console.log('  resources/tray.png         (tray 22×22)')
console.log('  resources/tray@2x.png      (tray 44×44 Retina)')
