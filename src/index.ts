/**
 * openfox-telegram — OpenFox plugin entry point.
 *
 * Bridges OpenFox's "waiting for the user" states to Telegram:
 * - `ask_user` questions (fed by the `turn.completed` hook)
 * - path / dangerous-command confirmations (polled from the REST API)
 *
 * Answers received in Telegram are routed back to OpenFox through its local
 * REST API (`/answer`, `/confirm-path`).
 */

import { TelegramBridge } from './bridge.js'
import { OpenFoxClient } from './openfox-client.js'
import { normalizeSettings, DEFAULT_SETTINGS, MIN_POLL_INTERVAL_SECONDS } from './settings.js'
import { TelegramClient } from './telegram-client.js'
import type { TelegramSettings } from './types.js'

// --- Minimal host contract (kept local so typecheck does not depend on the
// --- installed openfox version exporting `openfox/plugin`). -------------------

interface LocalizedString {
  en: string
  fr: string
}

interface SettingsField {
  key: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea'
  label: LocalizedString
  description?: LocalizedString
  default?: string | number | boolean
  placeholder?: string
  secret?: boolean
  required?: boolean
}

interface PluginSettingsSchema {
  title?: LocalizedString
  description?: LocalizedString
  fields: SettingsField[]
}

interface HookPayload {
  event: string
  sessionId: string
  data: Record<string, unknown>
}

interface PluginContext {
  id: string
  version: string
  runtime: { mode: string; configDirectory: string }
  logger: {
    debug(message: string, context?: Record<string, unknown>): void
    info(message: string, context?: Record<string, unknown>): void
    warn(message: string, context?: Record<string, unknown>): void
    error(message: string, context?: Record<string, unknown>): void
  }
  settings(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>
  notify(request: {
    title: LocalizedString
    body?: LocalizedString
    level?: 'info' | 'success' | 'warning' | 'error'
  }): void
}

interface PluginRegistry {
  context: PluginContext
  runtime: { mode: string; configDirectory: string }
  registerHook(event: string, handler: (payload: HookPayload) => void | Promise<void>): void
  registerRpc(method: string, handler: (params: Record<string, unknown>) => unknown | Promise<unknown>): void
  registerSettings(schema: PluginSettingsSchema): void
}

const SETTINGS_SCHEMA: PluginSettingsSchema = {
  title: { en: 'Telegram bridge', fr: 'Passerelle Telegram' },
  description: {
    en: 'Send OpenFox pending questions and path confirmations to Telegram, and answer them with inline buttons.',
    fr: 'Envoyer les questions en attente et confirmations de chemins d’OpenFox vers Telegram, et y répondre avec des boutons.',
  },
  fields: [
    {
      key: 'botToken',
      type: 'password',
      secret: true,
      label: { en: 'Bot token', fr: 'Jeton du bot' },
      description: {
        en: 'Token from @BotFather (format 123456:ABC-DEF…).',
        fr: 'Jeton fourni par @BotFather (format 123456:ABC-DEF…).',
      },
      required: true,
    },
    {
      key: 'chatId',
      type: 'text',
      label: { en: 'Chat id', fr: 'Identifiant du chat' },
      description: {
        en: 'Target chat id (private user id or group id, e.g. -1001234567890).',
        fr: 'Identifiant du chat cible (utilisateur privé ou groupe, ex. -1001234567890).',
      },
      placeholder: '123456789',
      required: true,
    },
    {
      key: 'allowedUserIds',
      type: 'text',
      label: { en: 'Allowed user ids', fr: 'Identifiants utilisateurs autorisés' },
      description: {
        en: 'Comma-separated Telegram user ids allowed to answer. Empty = anyone in the chat.',
        fr: 'Identifiants Telegram autorisés à répondre, séparés par des virgules. Vide = tout le chat.',
      },
      placeholder: '123456789, 987654321',
    },
    {
      key: 'openfoxBaseUrl',
      type: 'text',
      label: { en: 'OpenFox base URL', fr: 'URL de base OpenFox' },
      description: {
        en: 'Local OpenFox server used to read pending requests and post answers.',
        fr: 'Serveur OpenFox local utilisé pour lire les demandes en attente et envoyer les réponses.',
      },
      default: DEFAULT_SETTINGS.openfoxBaseUrl,
    },
    {
      key: 'sessionToken',
      type: 'password',
      secret: true,
      label: { en: 'OpenFox session token', fr: 'Jeton de session OpenFox' },
      description: {
        en: 'Only required when network authentication is enabled on the OpenFox server.',
        fr: 'Requis uniquement si l’authentification réseau est activée sur le serveur OpenFox.',
      },
    },
    {
      key: 'pollIntervalSeconds',
      type: 'number',
      label: { en: 'Confirmation poll interval (s)', fr: 'Intervalle de sondage des confirmations (s)' },
      description: {
        en: `How often to check OpenFox for pending confirmations (minimum ${MIN_POLL_INTERVAL_SECONDS}s).`,
        fr: `Fréquence de vérification des confirmations en attente (minimum ${MIN_POLL_INTERVAL_SECONDS}s).`,
      },
      default: DEFAULT_SETTINGS.pollIntervalSeconds,
    },
    {
      key: 'notifyOnAskUser',
      type: 'boolean',
      label: { en: 'Notify on agent questions', fr: 'Notifier les questions de l’agent' },
      description: {
        en: 'Send ask_user questions to Telegram.',
        fr: 'Envoyer les questions ask_user vers Telegram.',
      },
      default: DEFAULT_SETTINGS.notifyOnAskUser,
    },
    {
      key: 'notifyOnPathConfirmation',
      type: 'boolean',
      label: { en: 'Notify on path confirmations', fr: 'Notifier les confirmations de chemins' },
      description: {
        en: 'Send path / dangerous-command confirmations to Telegram.',
        fr: 'Envoyer les confirmations de chemins / commandes dangereuses vers Telegram.',
      },
      default: DEFAULT_SETTINGS.notifyOnPathConfirmation,
    },
    {
      key: 'interactiveReplies',
      type: 'boolean',
      label: { en: 'Interactive replies', fr: 'Réponses interactives' },
      description: {
        en: 'Show inline buttons and accept Telegram replies to answer OpenFox.',
        fr: 'Afficher les boutons inline et accepter les réponses Telegram pour répondre à OpenFox.',
      },
      default: DEFAULT_SETTINGS.interactiveReplies,
    },
  ],
}

function readSettings(context: PluginContext): TelegramSettings {
  try {
    return normalizeSettings(context.settings('global') as Record<string, unknown>)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

let activeBridge: TelegramBridge | null = null

export async function register(registry: PluginRegistry): Promise<void> {
  const { context } = registry

  const bridge = new TelegramBridge({
    logger: context.logger,
    createTelegram: (settings) => new TelegramClient({ token: settings.botToken }),
    createOpenFox: (settings) =>
      new OpenFoxClient({ baseUrl: settings.openfoxBaseUrl, sessionToken: settings.sessionToken }),
  })

  bridge.configure(readSettings(context))

  registry.registerSettings(SETTINGS_SCHEMA)

  registry.registerHook('turn.completed', async (payload) => {
    bridge.configure(readSettings(context))
    await bridge.onTurnCompleted(payload)
  })

  registry.registerRpc('telegram.test', async () => {
    bridge.configure(readSettings(context))
    return bridge.sendTestMessage()
  })

  registry.registerRpc('telegram.status', async () => {
    const settings = readSettings(context)
    return {
      configured: settings.botToken !== '' && settings.chatId !== '',
      running: bridge.isRunning(),
      pending: bridge.pendingCount(),
      pollIntervalSeconds: settings.pollIntervalSeconds,
      ...bridge.stats(),
    }
  })

  activeBridge = bridge
  bridge.start()

  context.notify({
    title: { en: 'Telegram bridge ready', fr: 'Passerelle Telegram prête' },
    body: {
      en: 'Pending OpenFox questions and confirmations will be forwarded to Telegram.',
      fr: 'Les questions et confirmations en attente d’OpenFox seront transmises à Telegram.',
    },
    level: 'info',
  })
}

/**
 * Called by the host when the plugin is disabled or uninstalled.
 * Background loops must stop so nothing leaks between reloads.
 */
export function deactivate(): void {
  activeBridge?.stop()
  activeBridge = null
}
