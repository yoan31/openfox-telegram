/**
 * TelegramBridge — orchestrates notifications and interactive replies.
 *
 * Responsibilities:
 * - push pending `ask_user` questions (fed by the `turn.completed` hook)
 * - poll OpenFox for pending path confirmations
 * - long-poll Telegram `getUpdates` and route answers back to OpenFox
 * - keep an anti-duplicate / purge map keyed by callId
 */

import { OpenFoxApiError } from './openfox-client.js'
import type { OpenFoxClient } from './openfox-client.js'
import type { TelegramClient, TelegramUpdate } from './telegram-client.js'
import { TelegramApiError } from './telegram-client.js'
import {
  confirmationKeyboard,
  decodeCallbackData,
  emptyKeyboard,
  escapeHtml,
  formatConfirmationMessage,
  formatQuestionMessage,
  questionKeyboard,
  splitQuestionToken,
  statusStateLabel,
  WAITING_SESSION_STATE,
} from './format.js'
import type {
  PendingConfirmation,
  PendingNotification,
  PendingQuestion,
  SessionRef,
  TelegramSettings,
} from './types.js'

export interface BridgeLogger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export interface BridgeOptions {
  logger: BridgeLogger
  createTelegram: (settings: TelegramSettings) => TelegramClient
  createOpenFox: (settings: TelegramSettings) => OpenFoxClient
  /**
   * Optional live settings source. When provided, the background loops re-read
   * the settings on every iteration, so the bridge picks up configuration
   * without waiting for a `turn.completed` hook to reconfigure it.
   */
  settingsProvider?: () => TelegramSettings
  now?: () => number
  randomToken?: () => string
}

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LONG_POLL_SECONDS = 25
const EMPTY_CALL_IDS: ReadonlySet<string> = new Set()
// Give up tracking a notification whose session cannot be read for this long,
// so a persistently failing session cannot leak tracked entries (and one
// GET /api/sessions/:id per poll) forever.
const UNREADABLE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export class TelegramBridge {
  private readonly logger: BridgeLogger
  private readonly createTelegram: BridgeOptions['createTelegram']
  private readonly createOpenFox: BridgeOptions['createOpenFox']
  private readonly settingsProvider: (() => TelegramSettings) | null
  private readonly now: () => number
  private readonly randomToken: () => string

  private settings: TelegramSettings | null = null
  private telegram: TelegramClient | null = null
  private openfox: OpenFoxClient | null = null

  private running = false
  private updateOffset = 0
  private controller: AbortController | null = null

  private readonly pendingByToken = new Map<string, PendingNotification>()
  private readonly tokenByCallId = new Map<string, string>()
  private readonly tokenByMessageId = new Map<number, string>()

  private sentCount = 0
  private lastSentAt: number | null = null
  private lastSentKind: 'question' | 'confirmation' | null = null
  private lastError: string | null = null

  constructor(options: BridgeOptions) {
    this.logger = options.logger
    this.createTelegram = options.createTelegram
    this.createOpenFox = options.createOpenFox
    this.settingsProvider = options.settingsProvider ?? null
    this.now = options.now ?? (() => Date.now())
    this.randomToken = options.randomToken ?? defaultToken
  }

  /** Apply (or refresh) configuration; clients are rebuilt from it. */
  configure(settings: TelegramSettings): void {
    // Skip the rebuild when nothing changed: the loops call this on every
    // iteration, so identical settings must not churn the client objects.
    if (this.settings && settingsEqual(this.settings, settings)) return
    this.settings = settings
    this.telegram = settings.botToken ? this.createTelegram(settings) : null
    this.openfox = settings.openfoxBaseUrl ? this.createOpenFox(settings) : null
  }

  /**
   * Re-read settings from the provider (when one was supplied) so the loops and
   * status reads do not depend on a hook to reconfigure the bridge. No-op
   * without a provider.
   */
  refreshSettings(): void {
    if (this.settingsProvider) this.configure(this.settingsProvider())
  }

  isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    void this.confirmationLoop()
    void this.updatesLoop()
    this.logger.info('Telegram bridge started')
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.controller?.abort()
    this.controller = null
    this.logger.info('Telegram bridge stopped')
  }

  private configured(): boolean {
    return Boolean(this.settings && this.telegram && this.openfox && this.settings.botToken && this.settings.chatId)
  }

  /** True when the bridge currently has usable Telegram + OpenFox clients. */
  isConfigured(): boolean {
    return this.configured()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }

  // --- outgoing notifications -------------------------------------------------

  /** Called by the `turn.completed` hook. */
  async onTurnCompleted(payload: { sessionId: string; data?: Record<string, unknown> }): Promise<void> {
    if (!this.configured() || !this.settings?.notifyOnAskUser) return
    if (payload.data?.['reason'] !== 'waiting_for_user') return
    try {
      const { session, pendingQuestions } = await this.openfox!.getSession(payload.sessionId)
      for (const question of pendingQuestions) {
        await this.sendQuestion(session, question)
      }
    } catch (error) {
      this.lastError = String(error)
      this.logger.warn('Failed to notify ask_user question', { error: String(error) })
    }
  }

  private async sendQuestion(session: SessionRef, question: PendingQuestion): Promise<void> {
    if (this.tokenByCallId.has(question.callId)) return
    const telegram = this.telegram!
    const token = this.newToken()
    const keyboard = this.settings?.interactiveReplies ? questionKeyboard(token, question) : undefined
    const state = this.settings?.includeSessionState ? WAITING_SESSION_STATE : null
    const text = formatQuestionMessage(question, session, this.displayOptions(session.id, session.projectId, state))
    const result = await telegram.sendMessage(this.settings!.chatId, text, keyboard)
    this.track({
      token,
      kind: 'question',
      sessionId: session.id,
      callId: question.callId,
      chatId: this.settings!.chatId,
      messageId: result.message_id,
      question,
      projectId: session.projectId,
      sessionTitle: session.title,
      sessionState: state,
      createdAt: this.now(),
    })
    this.recordSent('question')
    this.logger.info('Sent ask_user question to Telegram', { callId: question.callId, sessionId: session.id })
  }

  private async sendConfirmation(session: SessionRef, confirmation: PendingConfirmation): Promise<void> {
    if (this.tokenByCallId.has(confirmation.callId)) return
    const telegram = this.telegram!
    const token = this.newToken()
    const keyboard = this.settings?.interactiveReplies ? confirmationKeyboard(token) : undefined
    const state = this.settings?.includeSessionState ? WAITING_SESSION_STATE : null
    const text = formatConfirmationMessage(confirmation, session, this.displayOptions(session.id, session.projectId, state))
    const result = await telegram.sendMessage(this.settings!.chatId, text, keyboard)
    this.track({
      token,
      kind: 'confirmation',
      sessionId: session.id,
      callId: confirmation.callId,
      chatId: this.settings!.chatId,
      messageId: result.message_id,
      confirmation,
      projectId: session.projectId,
      sessionTitle: session.title,
      sessionState: state,
      createdAt: this.now(),
    })
    this.recordSent('confirmation')
    this.logger.info('Sent path confirmation to Telegram', { callId: confirmation.callId, sessionId: session.id })
  }

  /** Inline display options (state + session link) shared by send and edit. */
  private displayOptions(
    sessionId: string,
    projectId: string | undefined,
    sessionState?: string | null,
  ): { sessionState?: string | null; sessionLinkUrl?: string } {
    const options: { sessionState?: string | null; sessionLinkUrl?: string } = {}
    if (this.settings?.includeSessionState) options.sessionState = sessionState ?? null
    if (this.settings?.includeSessionLink) {
      const url = this.sessionLinkUrl(sessionId, projectId)
      if (url) options.sessionLinkUrl = url
    }
    return options
  }

  /** Build the OpenFox UI URL for a session, or null when the project is unknown. */
  private sessionLinkUrl(sessionId: string, projectId?: string): string | null {
    if (!projectId) return null
    const base = (this.settings?.openfoxBaseUrl ?? '').replace(/\/+$/, '')
    if (!base) return null
    return `${base}/p/${encodeURIComponent(projectId)}/s/${encodeURIComponent(sessionId)}`
  }

  private track(notification: PendingNotification): void {
    this.pendingByToken.set(notification.token, notification)
    this.tokenByCallId.set(notification.callId, notification.token)
    this.tokenByMessageId.set(notification.messageId, notification.token)
  }

  private untrack(token: string): void {
    const pending = this.pendingByToken.get(token)
    if (!pending) return
    this.pendingByToken.delete(token)
    this.tokenByCallId.delete(pending.callId)
    this.tokenByMessageId.delete(pending.messageId)
  }

  private newToken(): string {
    let token = this.randomToken()
    while (this.pendingByToken.has(token)) token = this.randomToken()
    return token
  }

  // --- confirmation polling ---------------------------------------------------

  private async confirmationLoop(): Promise<void> {
    while (this.running) {
      this.refreshSettings()
      const intervalMs = Math.max(5, this.settings?.pollIntervalSeconds ?? 10) * 1000
      await this.sleep(intervalMs)
      if (!this.running) break
      if (!this.configured()) continue
      // Nothing to do unless confirmations are forwarded or external answers cleared.
      if (!this.settings?.notifyOnPathConfirmation && !this.settings?.clearOnExternalAnswer) continue
      try {
        await this.pollConfirmations()
      } catch (error) {
        this.logger.warn('Pending poll failed', { error: String(error) })
      }
    }
  }

  /** One polling pass — exposed for testing. */
  async pollConfirmations(): Promise<void> {
    if (!this.openfox) return
    const { sessions, pendingConfirmationsBySession } = await this.openfox.listSessionsWithConfirmations()
    const sessionById = new Map(sessions.map((session) => [session.id, session]))

    if (this.settings?.notifyOnPathConfirmation) {
      for (const [sessionId, confirmations] of Object.entries(pendingConfirmationsBySession)) {
        const session = sessionById.get(sessionId) ?? { id: sessionId }
        for (const confirmation of confirmations) {
          if (this.tokenByCallId.has(confirmation.callId)) continue
          try {
            await this.sendConfirmation(session, confirmation)
          } catch (error) {
            this.logger.warn('Failed to send confirmation', { error: String(error), callId: confirmation.callId })
          }
        }
      }
    }

    await this.clearResolved(pendingConfirmationsBySession)
  }

  /**
   * Remove tracked notifications that OpenFox no longer reports as pending —
   * i.e. answered directly in OpenFox rather than through Telegram.
   *
   * Confirmations are already known from the bulk `pendingConfirmationsBySession`
   * payload, so no extra request is made for them. Questions are only visible
   * per session (`GET /api/sessions/:id`), so one request is made per session
   * that still has a tracked question. A session that returns 404 is gone, so
   * its notifications are cleared; any other read failure keeps them tracked.
   */
  private async clearResolved(
    pendingConfirmationsBySession: Record<string, PendingConfirmation[]>,
  ): Promise<void> {
    const confirmationPending = new Map<string, Set<string>>()
    for (const [sessionId, confirmations] of Object.entries(pendingConfirmationsBySession)) {
      confirmationPending.set(sessionId, new Set(confirmations.map((confirmation) => confirmation.callId)))
    }

    const questionSessionIds = new Set<string>()
    for (const pending of this.pendingByToken.values()) {
      if (pending.kind === 'question') questionSessionIds.add(pending.sessionId)
    }

    const questionPending = new Map<string, Set<string>>()
    const goneSessions = new Set<string>()
    const unreadableSessions = new Set<string>()
    for (const sessionId of questionSessionIds) {
      try {
        const session = await this.openfox!.getSession(sessionId)
        questionPending.set(sessionId, new Set(session.pendingQuestions.map((question) => question.callId)))
      } catch (error) {
        if (error instanceof OpenFoxApiError && error.status === 404) {
          // Session no longer exists: its notifications can never resolve.
          goneSessions.add(sessionId)
          continue
        }
        // Transient failure: keep tracking rather than clear by mistake.
        unreadableSessions.add(sessionId)
        this.logger.debug('Could not read session while clearing resolved notifications', {
          error: String(error),
          sessionId,
        })
      }
    }

    for (const pending of [...this.pendingByToken.values()]) {
      if (goneSessions.has(pending.sessionId)) {
        await this.clearResolvedMessage(pending)
        continue
      }
      if (
        unreadableSessions.has(pending.sessionId) &&
        this.now() - pending.createdAt >= UNREADABLE_SESSION_MAX_AGE_MS
      ) {
        // Session unreadable for too long: drop it instead of leaking forever.
        this.logger.warn('Dropping notification for unreadable session after max age', {
          callId: pending.callId,
          sessionId: pending.sessionId,
        })
        this.untrack(pending.token)
        continue
      }
      // Absent from the bulk payload = no pending confirmation for that session.
      const stillPending =
        pending.kind === 'question'
          ? questionPending.get(pending.sessionId)
          : (confirmationPending.get(pending.sessionId) ?? EMPTY_CALL_IDS)
      if (!stillPending) continue
      if (stillPending.has(pending.callId)) continue
      await this.clearResolvedMessage(pending)
    }
  }

  /**
   * The request was answered outside Telegram: delete the Telegram message
   * (falling back to an edit when deletion is impossible), then stop tracking it.
   */
  private async clearResolvedMessage(pending: PendingNotification): Promise<void> {
    if (this.settings?.clearOnExternalAnswer) {
      try {
        await this.telegram!.deleteMessage(pending.chatId, pending.messageId)
        this.logger.info('Deleted Telegram message after external answer', { callId: pending.callId })
      } catch (error) {
        this.logger.debug('Could not delete Telegram message, editing instead', { error: String(error) })
        const sessionState = await this.refreshSessionState(pending)
        try {
          await this.telegram!.editMessageText(
            pending.chatId,
            pending.messageId,
            `${this.baseMessage(pending, sessionState)}\n\n<b>Répondu sur OpenFox</b>`,
            emptyKeyboard(),
          )
        } catch (editError) {
          this.logger.debug('Could not edit Telegram message', { error: String(editError) })
        }
      }
    }
    this.untrack(pending.token)
  }

  // --- incoming updates -------------------------------------------------------

  private async updatesLoop(): Promise<void> {
    while (this.running) {
      this.refreshSettings()
      if (!this.configured() || !this.settings?.interactiveReplies) {
        await this.sleep(2000)
        continue
      }
      try {
        const updates = await this.telegram!.getUpdates(this.updateOffset, LONG_POLL_SECONDS)
        for (const update of updates) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1)
          await this.handleUpdate(update)
        }
      } catch (error) {
        if (this.controller?.signal.aborted) break
        this.logger.warn('Telegram getUpdates failed', { error: String(error) })
        await this.sleep(3000)
      }
    }
  }

  /** Route a single Telegram update. Exposed for testing. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query)
      return
    }
    if (update.message) {
      await this.handleMessage(update.message)
    }
  }

  private isAllowedUser(userId: number | undefined): boolean {
    if (userId === undefined) return false
    const allowed = this.settings?.allowedUserIds ?? []
    return allowed.length === 0 || allowed.includes(userId)
  }

  private async handleCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!this.isAllowedUser(query.from?.id)) {
      await this.safeAnswerCallback(query.id, 'Non autorisé')
      return
    }
    const data = decodeCallbackData(query.data)
    if (!data) {
      await this.safeAnswerCallback(query.id)
      return
    }
    const lookupToken = data.kind === 'question' ? splitQuestionToken(data.token).id : data.token
    const pending = this.pendingByToken.get(lookupToken)
    if (!pending) {
      await this.safeAnswerCallback(query.id, 'Demande expirée')
      return
    }

    if (pending.kind === 'confirmation') {
      await this.resolveConfirmation(pending, data.action, query)
      return
    }
    await this.resolveQuestion(pending, data, query)
  }

  private async resolveConfirmation(
    pending: PendingNotification,
    action: string,
    query: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
    const approved = action === 'approve' || action === 'always'
    const alwaysAllow = action === 'always'
    const ok = await this.openfox!.confirmPath(pending.sessionId, pending.callId, approved, alwaysAllow)
    const verdict = !approved ? '❌ Refusé' : alwaysAllow ? '🔓 Toujours autorisé' : '✅ Approuvé'
    await this.safeAnswerCallback(query.id, ok ? verdict : 'Échec de l’envoi à OpenFox')
    await this.finalize(pending, verdict)
  }

  private async resolveQuestion(
    pending: PendingNotification,
    data: { token: string; action: string },
    query: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
    const question = pending.question
    let answer = ''
    let verdict = ''

    if (data.action === 'skip') {
      answer = '[user skipped]'
      verdict = '⏭️ Ignoré'
    } else if (data.action === 'approve') {
      answer = 'yes'
      verdict = '✅ Oui'
    } else if (data.action === 'deny') {
      answer = 'no'
      verdict = '❌ Non'
    } else if (data.action === 'answer') {
      const { optionValue } = splitQuestionToken(data.token)
      answer = optionValue ?? ''
      const label = question?.options?.find((option) => option.value === answer)?.label ?? answer
      verdict = `✅ ${label}`
    } else {
      await this.safeAnswerCallback(query.id)
      return
    }

    const ok = await this.openfox!.answerQuestion(pending.sessionId, pending.callId, answer)
    await this.safeAnswerCallback(query.id, ok ? verdict : 'Échec de l’envoi à OpenFox')
    await this.finalize(pending, verdict)
  }

  private async handleMessage(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
    if (!this.isAllowedUser(message.from?.id)) return
    if (message.chat.id.toString() !== (this.settings?.chatId ?? '')) return
    const text = message.text?.trim()
    if (!text) return

    const pending = this.findLatestTextQuestion(message.chat.id)
    if (!pending) return

    const ok = await this.openfox!.answerQuestion(pending.sessionId, pending.callId, text)
    await this.finalize(pending, ok ? `✅ ${text}` : 'Échec de l’envoi à OpenFox')
  }

  private findLatestTextQuestion(chatId: number): PendingNotification | null {
    let best: PendingNotification | null = null
    for (const pending of this.pendingByToken.values()) {
      if (pending.kind !== 'question') continue
      if (pending.chatId !== chatId.toString()) continue
      if (pending.question?.type !== 'text') continue
      if (!best || pending.createdAt > best.createdAt) best = pending
    }
    return best
  }

  /** Base text of a tracked notification, used when editing its Telegram message. */
  private baseMessage(pending: PendingNotification, sessionState?: string | null): string {
    const session = { id: pending.sessionId, title: pending.sessionTitle }
    const options = this.displayOptions(
      pending.sessionId,
      pending.projectId,
      sessionState ?? pending.sessionState ?? null,
    )
    return pending.kind === 'confirmation'
      ? formatConfirmationMessage(pending.confirmation!, session, options)
      : formatQuestionMessage(pending.question!, session, options)
  }

  /**
   * Re-read the session state before editing, so the final message reflects the
   * real post-answer state (agent resumed, waiting again, done…). Falls back to
   * the state remembered at send time when the read fails or the setting is off.
   */
  private async refreshSessionState(pending: PendingNotification): Promise<string | null | undefined> {
    if (!this.settings?.includeSessionState) return pending.sessionState ?? null
    try {
      const status = await this.openfox!.getSessionStatus(pending.sessionId)
      return statusStateLabel(status.state) || null
    } catch (error) {
      this.logger.debug('Could not refresh session state', { error: String(error), sessionId: pending.sessionId })
      return pending.sessionState ?? null
    }
  }

  /** Edit the Telegram message to show the outcome and stop tracking it. */
  private async finalize(pending: PendingNotification, verdict: string): Promise<void> {
    this.untrack(pending.token)
    const sessionState = await this.refreshSessionState(pending)
    try {
      await this.telegram!.editMessageText(
        pending.chatId,
        pending.messageId,
        `${this.baseMessage(pending, sessionState)}\n\n<b>${escapeHtml(verdict)}</b>`,
        emptyKeyboard(),
      )
    } catch (error) {
      this.logger.debug('Could not edit Telegram message', { error: String(error) })
    }
  }

  private async safeAnswerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.telegram!.answerCallbackQuery(callbackQueryId, text)
    } catch (error) {
      this.logger.debug('answerCallbackQuery failed', { error: String(error) })
    }
  }

  /** Verify the Telegram side: resolve the bot and send a test message. */
  async testTelegram(): Promise<{ ok: boolean; error?: string }> {
    if (!this.settings?.botToken || !this.settings.chatId) {
      return { ok: false, error: 'botToken and chatId are required' }
    }
    try {
      const client = this.telegram ?? this.createTelegram(this.settings)
      const me = await client.getMe()
      await client.sendMessage(
        this.settings.chatId,
        `✅ <b>OpenFox Telegram</b>\nTest de connexion réussi${
          me.username ? ` en tant que @${escapeHtml(me.username)}` : ''
        }.`,
      )
      return { ok: true }
    } catch (error) {
      const message =
        error instanceof TelegramApiError ? error.message : error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  /** Verify the OpenFox side by reading the sessions endpoint (read-only). */
  async testOpenFox(): Promise<{ ok: boolean; error?: string }> {
    if (!this.settings?.openfoxBaseUrl) {
      return { ok: false, error: 'openfoxBaseUrl is required' }
    }
    try {
      const client = this.openfox ?? this.createOpenFox(this.settings)
      await client.listSessionsWithConfirmations()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  /**
   * Verify both settings halves (Telegram + OpenFox). Used by the
   * `telegram.test` RPC behind the settings button.
   *
   * The read-only OpenFox probe runs first so a partial failure never leaves a
   * success message in the chat: the Telegram test message is only sent once
   * the OpenFox side is confirmed reachable.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const openfox = await this.testOpenFox()
    if (!openfox.ok) return { ok: false, error: `OpenFox: ${openfox.error}` }
    const telegram = await this.testTelegram()
    if (!telegram.ok) return { ok: false, error: `Telegram: ${telegram.error}` }
    return { ok: true }
  }

  /** Number of requests currently awaiting an answer (for diagnostics). */
  pendingCount(): number {
    return this.pendingByToken.size
  }

  private recordSent(kind: 'question' | 'confirmation'): void {
    this.sentCount += 1
    this.lastSentAt = this.now()
    this.lastSentKind = kind
    this.lastError = null
  }

  /** Diagnostic snapshot exposed through the `telegram.status` RPC. */
  stats(): {
    sentCount: number
    lastSentAt: number | null
    lastSentKind: 'question' | 'confirmation' | null
    lastError: string | null
  } {
    return {
      sentCount: this.sentCount,
      lastSentAt: this.lastSentAt,
      lastSentKind: this.lastSentKind,
      lastError: this.lastError,
    }
  }
}

function defaultToken(): string {
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)]
  }
  return out
}

/** Shallow-but-exact comparison of normalized settings (arrays compared by value). */
function settingsEqual(a: TelegramSettings, b: TelegramSettings): boolean {
  const keys = Object.keys(a) as (keyof TelegramSettings)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const left = a[key]
    const right = b[key]
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((value, index) => value === right[index])
    }
    return left === right
  })
}
