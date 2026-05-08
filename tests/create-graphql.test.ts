import { describe, it, expect, afterEach, vi } from 'vitest'
import { Operation, gql } from '../src/graphql.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Operation', () => {
  it('stores the operation string', () => {
    const op = new Operation<{ id: string }, { name: string }>({
      operation: 'query GetUser($id: String!) { user(id: $id) { name } }',
    })
    expect(op.config.operation).toBe('query GetUser($id: String!) { user(id: $id) { name } }')
  })

  it('stores optional config fields', () => {
    const mw = vi.fn()
    const op = new Operation<Record<string, never>, { ok: boolean }>({
      operation: 'query { health }',
      dedupe: true,
      headers: { 'X-Custom': 'yes' },
      middleware: [mw],
    })
    expect(op.config.dedupe).toBe(true)
    expect(op.config.headers).toEqual({ 'X-Custom': 'yes' })
    expect(op.config.middleware).toEqual([mw])
  })
})

describe('gql', () => {
  it('returns the template string unchanged', () => {
    const query = gql`query GetUser($id: String!) { user(id: $id) { id name } }`
    expect(query).toBe('query GetUser($id: String!) { user(id: $id) { id name } }')
  })

  it('interpolates values', () => {
    const fields = 'id name'
    const query = gql`query { user { ${fields} } }`
    expect(query).toBe('query { user { id name } }')
  })
})
