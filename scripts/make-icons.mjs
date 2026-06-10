#!/usr/bin/env node
// Generates the app icons with zero dependencies:
//   public/icon.png (192×192) and public/icon-512.png — used by notifications,
//   apple-touch-icon, and the PWA manifest.
// Design: dark app background (#0e1410) with a centered accent dot (#7cb342) —
// the "pin" mark. Raw PNG encoding (IHDR/IDAT/IEND) with zlib deflate.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const BG = [0x0e, 0x14, 0x10, 255]
const ACCENT = [0x7c, 0xb3, 0x42, 255]

// --- CRC32 (PNG chunk checksums) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function makePng(size) {
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.34
  const r2 = r * r

  // RGBA scanlines, each prefixed with filter byte 0.
  const raw = Buffer.alloc(size * (1 + size * 4))
  let off = 0
  for (let y = 0; y < size; y++) {
    raw[off++] = 0
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const px = dx * dx + dy * dy <= r2 ? ACCENT : BG
      raw[off++] = px[0]
      raw[off++] = px[1]
      raw[off++] = px[2]
      raw[off++] = px[3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // compression/filter/interlace = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [file, size] of [
  ['public/icon.png', 192],
  ['public/icon-512.png', 512],
]) {
  writeFileSync(join(ROOT, file), makePng(size))
  console.log(`wrote ${file} (${size}×${size})`)
}
