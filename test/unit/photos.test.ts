import { describe, expect, it } from 'vitest'
import {
  checkImageUpload,
  extForType,
  isAllowedImageType,
  photoKey,
} from '../../functions/lib/photos'
import { LIMITS } from '../../functions/lib/validate'

describe('isAllowedImageType', () => {
  it('accepts common image types', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
      expect(isAllowedImageType(t)).toBe(true)
    }
  })
  it('is case-insensitive', () => {
    expect(isAllowedImageType('IMAGE/JPEG')).toBe(true)
  })
  it('rejects non-image and missing types', () => {
    expect(isAllowedImageType('application/pdf')).toBe(false)
    expect(isAllowedImageType('text/html')).toBe(false)
    expect(isAllowedImageType(null)).toBe(false)
    expect(isAllowedImageType(undefined)).toBe(false)
  })
})

describe('extForType', () => {
  it('maps known types to extensions', () => {
    expect(extForType('image/jpeg')).toBe('jpg')
    expect(extForType('image/png')).toBe('png')
  })
  it('falls back to bin for unknown', () => {
    expect(extForType('application/octet-stream')).toBe('bin')
  })
})

describe('checkImageUpload', () => {
  it('accepts a small jpeg', () => {
    expect(checkImageUpload('image/jpeg', 1024)).toEqual({ ok: true })
  })
  it('rejects a non-image type', () => {
    expect(checkImageUpload('application/pdf', 1024).ok).toBe(false)
  })
  it('rejects an empty upload', () => {
    expect(checkImageUpload('image/png', 0).ok).toBe(false)
  })
  it('rejects over the size cap', () => {
    expect(checkImageUpload('image/png', LIMITS.photo_bytes + 1).ok).toBe(false)
  })
  it('accepts exactly at the size cap', () => {
    expect(checkImageUpload('image/png', LIMITS.photo_bytes)).toEqual({ ok: true })
  })
})

describe('photoKey', () => {
  it('builds gigs/<gigId>/<id>.<ext>', () => {
    expect(photoKey('g1', 'p1', 'image/jpeg')).toBe('gigs/g1/p1.jpg')
  })
})
