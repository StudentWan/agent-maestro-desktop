import { describe, it, expect } from 'vitest'
import { mapModelName } from '../model-mapper'

describe('mapModelName', () => {
  it('maps known opus models', () => {
    expect(mapModelName('claude-opus-4-6')).toBe('claude-opus-4.6')
    expect(mapModelName('claude-opus-4-5')).toBe('claude-opus-4.5')
  })

  it('maps 1M context variants', () => {
    expect(mapModelName('claude-opus-4-6-1m')).toBe('claude-opus-4.6-1m')
    expect(mapModelName('claude-sonnet-4-6-1m')).toBe('claude-sonnet-4.6-1m')
  })

  it('maps known sonnet models', () => {
    expect(mapModelName('claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
    expect(mapModelName('claude-sonnet-4-5')).toBe('claude-sonnet-4.5')
    expect(mapModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4')
  })

  it('maps known haiku models', () => {
    expect(mapModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5')
    expect(mapModelName('claude-3-5-haiku-20241022')).toBe('claude-haiku-4.5')
    expect(mapModelName('claude-3-haiku-20240307')).toBe('claude-haiku-4.5')
  })

  it('strips date suffix and maps via table', () => {
    expect(mapModelName('claude-opus-4-6-20260101')).toBe('claude-opus-4.6')
    expect(mapModelName('claude-sonnet-4-6-20261231')).toBe('claude-sonnet-4.6')
  })

  it('converts unknown claude-<family>-<major>-<minor> pattern', () => {
    expect(mapModelName('claude-opus-5-0')).toBe('claude-opus-5.0')
    expect(mapModelName('claude-sonnet-5-1')).toBe('claude-sonnet-5.1')
    expect(mapModelName('claude-haiku-5-2')).toBe('claude-haiku-5.2')
  })

  it('converts unknown claude-<family>-<major>-<minor>-1m pattern', () => {
    expect(mapModelName('claude-opus-5-0-1m')).toBe('claude-opus-5.0-1m')
    expect(mapModelName('claude-sonnet-5-1-1m')).toBe('claude-sonnet-5.1-1m')
  })

  it('passes through already-correct Copilot model IDs', () => {
    expect(mapModelName('claude-opus-4.6')).toBe('claude-opus-4.6')
    expect(mapModelName('claude-sonnet-4.6')).toBe('claude-sonnet-4.6')
    expect(mapModelName('claude-haiku-4.5')).toBe('claude-haiku-4.5')
  })

  it('passes through unknown non-Claude models', () => {
    expect(mapModelName('gpt-4.1')).toBe('gpt-4.1')
    expect(mapModelName('random-model')).toBe('random-model')
  })
})
