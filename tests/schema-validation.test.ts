import { describe, it, expect } from 'vitest'
import { runSchema } from '../src/utils/validate.js'
import type { StandardSchemaV1 } from '../src/types.js'

/** A Standard Schema validator built from a plain predicate — no dependency needed to test one. */
const schemaOf = <T>(fn: (v: unknown) => { value: T } | { issues: { message: string }[] }, async = false): StandardSchemaV1<T> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) => (async ? Promise.resolve(fn(v)) : fn(v)) as never,
  },
})

const evenNumber = (async = false) =>
  schemaOf<number>(v => (typeof v === 'number' && v % 2 === 0 ? { value: v } : { issues: [{ message: 'not an even number' }] }), async)

describe('runSchema', () => {
  it('returns the validated value on success', async () => {
    const r = await runSchema(evenNumber(), 4)
    expect(r).toEqual({ ok: true, value: 4 })
  })

  it('returns the issues on failure', async () => {
    const r = await runSchema(evenNumber(), 3)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues).toEqual([{ message: 'not an even number' }])
  })

  it('awaits a validator that returns a promise', async () => {
    const r = await runSchema(evenNumber(true), 4)
    expect(r).toEqual({ ok: true, value: 4 })
  })

  it('returns the transformed value, not the input', async () => {
    // The whole reason `data` is the schema's output: a transforming schema
    // changes what the caller receives.
    const doubled = schemaOf<number>(v => ({ value: (v as number) * 2 }))
    const r = await runSchema(doubled, 21)
    expect(r).toEqual({ ok: true, value: 42 })
  })
})
