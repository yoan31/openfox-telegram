import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings, parseAllowedUserIds } from './settings.js'

describe('normalizeSettings', () => {
  it('returns defaults for empty input', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('coerces strings and numbers', () => {
    const settings = normalizeSettings({
      botToken: '  123:abc ',
      chatId: '42',
      openfoxBaseUrl: 'http://127.0.0.1:10369/',
      pollIntervalSeconds: '30',
      notifyOnAskUser: 'false',
      allowedUserIds: '1, 2;3',
    })
    expect(settings.botToken).toBe('123:abc')
    expect(settings.openfoxBaseUrl).toBe('http://127.0.0.1:10369')
    expect(settings.pollIntervalSeconds).toBe(30)
    expect(settings.notifyOnAskUser).toBe(false)
    expect(settings.allowedUserIds).toEqual([1, 2, 3])
  })

  it('clamps the poll interval to the minimum', () => {
    expect(normalizeSettings({ pollIntervalSeconds: 1 }).pollIntervalSeconds).toBe(5)
  })

  it('defaults the session display toggles to true', () => {
    const settings = normalizeSettings({})
    expect(settings.includeSessionLink).toBe(true)
    expect(settings.includeSessionState).toBe(true)
  })

  it('reads the session display toggles from strings', () => {
    const settings = normalizeSettings({ includeSessionLink: 'false', includeSessionState: 'false' })
    expect(settings.includeSessionLink).toBe(false)
    expect(settings.includeSessionState).toBe(false)
  })
})

describe('parseAllowedUserIds', () => {
  it('accepts arrays and strings', () => {
    expect(parseAllowedUserIds([1, '2', 'x'])).toEqual([1, 2])
    expect(parseAllowedUserIds('10 20')).toEqual([10, 20])
    expect(parseAllowedUserIds(undefined)).toEqual([])
  })
})
