// =============================================================================
// result.test.ts — Tests for ApiError class and Result factory helpers
// =============================================================================
//
// These tests verify:
// 1. ApiError correctly stores HTTP error properties (status, body, headers, etc.)
// 2. ApiError handles network error edge cases (status 0, empty statusText)
// 3. createSuccessResult produces a well-formed success Result
// 4. createErrorResult produces a well-formed error Result with an HTTP response
// 5. createNetworkErrorResult produces an error Result with null response
// =============================================================================

import { describe, it, expect } from 'vitest'
import { ApiError, createSuccessResult, createErrorResult, createNetworkErrorResult } from '../src/result.js'

describe('ApiError', () => {
  it('stores HTTP error properties', () => {
    // Simulates a typical 404 response — verifies all fields are stored correctly
    const error = new ApiError({
      status: 404,
      statusText: 'Not Found',
      body: { message: 'Resource not found' },
      headers: new Headers({ 'x-req-id': '123' }),
      request: { method: 'GET', url: '/api/items/99', params: { id: '99' } }
    })

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(404)
    expect(error.statusText).toBe('Not Found')
    expect(error.body).toEqual({ message: 'Resource not found' })
    expect(error.headers.get('x-req-id')).toBe('123')
    expect(error.request.method).toBe('GET')
    expect(error.request.url).toBe('/api/items/99')
    expect(error.request.params).toEqual({ id: '99' })
  })

  it('uses status 0 and empty string for network errors', () => {
    // Network errors (DNS failure, offline, etc.) have no HTTP response,
    // so status is 0 and statusText is '' by convention
    const error = new ApiError({
      status: 0,
      statusText: '',
      body: new Error('Failed to fetch'),
      headers: new Headers(),
      request: { method: 'GET', url: '/api/items', params: {} }
    })

    expect(error.status).toBe(0)
    expect(error.statusText).toBe('')
    expect(error.body).toBeInstanceOf(Error)
  })
})

describe('createSuccessResult', () => {
  it('returns data with null error', () => {
    // Success results should have data populated, error null, and the raw Response
    const mockResponse = new Response('{}', { status: 200 })
    const retryFn = () => Promise.resolve(createSuccessResult({ id: 1 }, mockResponse, retryFn))
    const result = createSuccessResult({ id: 1 }, mockResponse, retryFn)

    expect(result.data).toEqual({ id: 1 })
    expect(result.error).toBeNull()
    expect(result.response).toBe(mockResponse)
    expect(typeof result.retry).toBe('function')
  })
})

describe('createErrorResult', () => {
  it('returns error with null data', () => {
    // Error results should have data null, error populated, and the raw Response
    // (Response is available because this is an HTTP error, not a network error)
    const mockResponse = new Response('Not Found', { status: 404 })
    const error = new ApiError({
      status: 404,
      statusText: 'Not Found',
      body: 'Not Found',
      headers: new Headers(),
      request: { method: 'GET', url: '/test', params: {} }
    })
    const retryFn = () => Promise.resolve(createErrorResult(error, mockResponse, retryFn))
    const result = createErrorResult(error, mockResponse, retryFn)

    expect(result.data).toBeNull()
    expect(result.error).toBe(error)
    expect(result.response).toBe(mockResponse)
  })
})

describe('createNetworkErrorResult', () => {
  it('returns error with null response', () => {
    // Network errors have NO HTTP response at all — response should be null
    // This happens when fetch itself throws (DNS failure, offline, abort, etc.)
    const error = new ApiError({
      status: 0,
      statusText: '',
      body: new Error('Failed to fetch'),
      headers: new Headers(),
      request: { method: 'GET', url: '/test', params: {} }
    })
    const retryFn = () => Promise.resolve(createNetworkErrorResult(error, retryFn))
    const result = createNetworkErrorResult(error, retryFn)

    expect(result.data).toBeNull()
    expect(result.error).toBe(error)
    expect(result.response).toBeNull()
  })
})
