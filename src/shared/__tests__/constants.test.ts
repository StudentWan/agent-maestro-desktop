import { describe, it, expect } from 'vitest'
import {
  GITHUB_CLIENT_ID,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_VERIFICATION_URL,
  COPILOT_TOKEN_URL,
  COPILOT_CHAT_URL,
  DEFAULT_PROXY_PORT,
  PROXY_HOST,
  TOKEN_REFRESH_INTERVAL_MS,
  TOKEN_EXPIRY_DURATION_MS,
  DEVICE_FLOW_POLL_INTERVAL_MS,
  APP_NAME,
  APP_USER_AGENT,
  EDITOR_VERSION,
  EDITOR_PLUGIN_VERSION,
  MACHINE_ID,
} from '../constants'

describe('shared constants', () => {
  it('exports GitHub OAuth constants', () => {
    expect(GITHUB_CLIENT_ID).toBeDefined()
    expect(typeof GITHUB_CLIENT_ID).toBe('string')
    expect(GITHUB_DEVICE_CODE_URL).toContain('github.com')
    expect(GITHUB_ACCESS_TOKEN_URL).toContain('github.com')
    expect(GITHUB_DEVICE_VERIFICATION_URL).toContain('github.com')
  })

  it('exports Copilot API constants', () => {
    expect(COPILOT_TOKEN_URL).toContain('github.com')
    expect(COPILOT_CHAT_URL).toContain('githubcopilot.com')
  })

  it('exports proxy defaults', () => {
    expect(DEFAULT_PROXY_PORT).toBe(23337)
    expect(PROXY_HOST).toBe('127.0.0.1')
  })

  it('exports token timing constants', () => {
    expect(TOKEN_REFRESH_INTERVAL_MS).toBe(25 * 60 * 1000)
    expect(TOKEN_EXPIRY_DURATION_MS).toBe(30 * 60 * 1000)
    expect(TOKEN_REFRESH_INTERVAL_MS).toBeLessThan(TOKEN_EXPIRY_DURATION_MS)
  })

  it('exports device flow polling interval', () => {
    expect(DEVICE_FLOW_POLL_INTERVAL_MS).toBe(5000)
  })

  it('exports app identity constants', () => {
    expect(APP_NAME).toBe('Agent Maestro Desktop')
    expect(APP_USER_AGENT).toContain('GitHubCopilotChat')
    expect(EDITOR_VERSION).toContain('vscode/')
    expect(EDITOR_PLUGIN_VERSION).toContain('copilot-chat/')
    expect(MACHINE_ID).toBeDefined()
  })
})
