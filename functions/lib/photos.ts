// Photo upload helpers — pure. The R2 put/get lives in the handler.

import { LIMITS } from './validate'

export const MAX_PHOTOS_PER_GIG = 6

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

export function isAllowedImageType(contentType: string | null | undefined): boolean {
  return (
    !!contentType && Object.prototype.hasOwnProperty.call(EXT_BY_TYPE, contentType.toLowerCase())
  )
}

export function extForType(contentType: string): string {
  return EXT_BY_TYPE[contentType.toLowerCase()] ?? 'bin'
}

// Validate an upload's content-type and byte size. Returns ok or a reason.
export function checkImageUpload(
  contentType: string | null | undefined,
  byteLength: number,
): { ok: true } | { ok: false; reason: string } {
  if (!isAllowedImageType(contentType)) return { ok: false, reason: 'unsupported image type' }
  if (!Number.isFinite(byteLength) || byteLength <= 0) return { ok: false, reason: 'empty upload' }
  if (byteLength > LIMITS.photo_bytes) return { ok: false, reason: 'image too large' }
  return { ok: true }
}

// Deterministic-prefix object key for a gig's photo; `id` is the unique part.
export function photoKey(gigId: string, id: string, contentType: string): string {
  return `gigs/${gigId}/${id}.${extForType(contentType)}`
}
