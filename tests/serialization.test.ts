import { describe, it, expect } from 'vitest'
import { serializeBody } from '../src/utils/serialize.js'

describe('serializeBody', () => {
  it('serializes plain objects as JSON', () => {
    const { body, contentType } = serializeBody({ name: 'test' })
    expect(body).toBe('{"name":"test"}')
    expect(contentType).toBe('application/json')
  })

  it('passes FormData as-is with no content type', () => {
    const formData = new FormData()
    formData.append('file', 'data')
    const { body, contentType } = serializeBody(formData)
    expect(body).toBe(formData)
    expect(contentType).toBeNull()
  })

  it('passes URLSearchParams as-is', () => {
    const params = new URLSearchParams({ a: '1' })
    const { body, contentType } = serializeBody(params)
    expect(body).toBe(params)
    expect(contentType).toBe('application/x-www-form-urlencoded')
  })

  it('passes Blob as-is', () => {
    const blob = new Blob(['data'])
    const { body, contentType } = serializeBody(blob)
    expect(body).toBe(blob)
    expect(contentType).toBe('application/octet-stream')
  })

  it('passes ArrayBuffer as-is', () => {
    const buffer = new ArrayBuffer(8)
    const { body, contentType } = serializeBody(buffer)
    expect(body).toBe(buffer)
    expect(contentType).toBe('application/octet-stream')
  })

  it('passes strings as-is', () => {
    const { body, contentType } = serializeBody('raw text')
    expect(body).toBe('raw text')
    expect(contentType).toBe('text/plain')
  })

  it('returns null body for null input', () => {
    const { body, contentType } = serializeBody(null)
    expect(body).toBeNull()
    expect(contentType).toBeNull()
  })

  it('returns null body for undefined input', () => {
    const { body, contentType } = serializeBody(undefined)
    expect(body).toBeNull()
    expect(contentType).toBeNull()
  })
})
