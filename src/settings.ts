import type { TelegramSettings } from './types.js'

export const DEFAULT_SETTINGS: TelegramSettings = {
  botToken: '',
  chatId: '',
  allowedUserIds: [],
  openfoxBaseUrl: 'http://127.0.0.1:10369',
  sessionToken: '',
  pollIntervalSeconds: 10,
  notifyOnAskUser: true,
  notifyOnPathConfirmation: true,
  interactiveReplies: true,
  clearOnExternalAnswer: true,
}

export const MIN_POLL_INTERVAL_SECONDS = 5

/** Parse a comma/space separated list of Telegram user ids. */
export function parseAllowedUserIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
  }
  if (typeof raw !== 'string') return []
  return raw
    .split(/[\s,;]+/)
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return fallback
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Normalize the raw `context.settings()` values into a typed settings object. */
export function normalizeSettings(values: Record<string, unknown> | undefined): TelegramSettings {
  const raw = values ?? {}
  const pollInterval = Math.max(
    MIN_POLL_INTERVAL_SECONDS,
    Math.floor(asNumber(raw['pollIntervalSeconds'], DEFAULT_SETTINGS.pollIntervalSeconds)),
  )
  return {
    botToken: asString(raw['botToken'], DEFAULT_SETTINGS.botToken),
    chatId: asString(raw['chatId'], DEFAULT_SETTINGS.chatId),
    allowedUserIds: parseAllowedUserIds(raw['allowedUserIds']),
    openfoxBaseUrl: asString(raw['openfoxBaseUrl'], DEFAULT_SETTINGS.openfoxBaseUrl).replace(/\/+$/, ''),
    sessionToken: asString(raw['sessionToken'], DEFAULT_SETTINGS.sessionToken),
    pollIntervalSeconds: pollInterval,
    notifyOnAskUser: asBoolean(raw['notifyOnAskUser'], DEFAULT_SETTINGS.notifyOnAskUser),
    notifyOnPathConfirmation: asBoolean(raw['notifyOnPathConfirmation'], DEFAULT_SETTINGS.notifyOnPathConfirmation),
    interactiveReplies: asBoolean(raw['interactiveReplies'], DEFAULT_SETTINGS.interactiveReplies),
    clearOnExternalAnswer: asBoolean(raw['clearOnExternalAnswer'], DEFAULT_SETTINGS.clearOnExternalAnswer),
  }
}

/** True when the plugin has enough configuration to talk to Telegram + OpenFox. */
export function isConfigured(settings: TelegramSettings): boolean {
  return settings.botToken !== '' && settings.chatId !== ''
}
