import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildCopilotHeaders, buildCopilotStreamHeaders } from '../headers'

// Mock uuid to produce deterministic values
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}))

describe('buildCopilotHeaders', () => {
  it('includes Authorization bearer token', () => {
    const headers = buildCopilotHeaders('my-token')
    expect(headers['Authorization']).toBe('Bearer my-token')
  })

  it('sets Content-Type to application/json', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('sets Accept to application/json', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Accept']).toBe('application/json')
  })

  it('includes Editor-Version header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Editor-Version']).toBeDefined()
    expect(headers['Editor-Version']).toContain('vscode/')
  })

  it('includes Editor-Plugin-Version header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Editor-Plugin-Version']).toBeDefined()
    expect(headers['Editor-Plugin-Version']).toContain('copilot-chat/')
  })

  it('includes User-Agent header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['User-Agent']).toBeDefined()
  })

  it('includes X-Request-Id from uuid', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['X-Request-Id']).toBe('test-uuid-1234')
  })

  it('includes Openai-Organization header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Openai-Organization']).toBe('github-copilot')
  })

  it('includes Copilot-Integration-Id header', () => {
    const headers = buildCopilotHeaders('token')
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat')
  })
})

describe('buildCopilotStreamHeaders', () => {
  it('overrides Accept to text/event-stream', () => {
    const headers = buildCopilotStreamHeaders('token')
    expect(headers['Accept']).toBe('text/event-stream')
  })

  it('still includes Authorization', () => {
    const headers = buildCopilotStreamHeaders('token')
    expect(headers['Authorization']).toBe('Bearer token')
  })

  it('still includes all other headers from base', () => {
    const headers = buildCopilotStreamHeaders('token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Openai-Organization']).toBe('github-copilot')
  })
})
