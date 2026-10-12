/**
 * TelegramBridge — orchestrates notifications and interactive replies.
 *
 * Responsibilities:
 * - push pending `ask_user` questions (fed by the `turn.completed` hook)
 * - poll OpenFox for pending path confirmations
 * - long-poll Telegram `getUpdates` and route answers back to OpenFox
 * - keep an anti-duplicate / purge map keyed by callId
 */

import type { OpenFoxClient } from './openfox-client.js'
import type { TelegramClient, TelegramUpdate } from './telegram-client.js'
import { TelegramApiError } from './telegram-client.js'
import {
  confirmationKeyboard,
  decodeCallbackData,
  escapeHtml,
  formatConfirmationMessage,
  formatQuestionMessage,
  questionKeyboard,
  splitQuestionToken,
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
  now?: () => number
  randomToken?: () => string
}

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LONG_POLL_SECONDS = 25

export class TelegramBridge {
  private readonly logger: BridgeLogger
  private readonly createTelegram: BridgeOptions['createTelegram']
  private readonly createOpenFox: BridgeOptions['createOpenFox']
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

  constructor(options: BridgeOptions) {
    this.logger = options.logger
    this.createTelegram = options.createTelegram
    this.createOpenFox = options.createOpenFox
    this.now = options.now ?? (() => Date.now())
    this.randomToken = options.randomToken ?? defaultToken
  }

  /** Apply (or refresh) configuration; clients are rebuilt from it. */
  configure(settings: TelegramSettings): void {
    this.settings = settings
    this.telegram = settings.botToken ? this.createTelegram(settings) : null
    this.openfox = settings.openfoxBaseUrl ? this.createOpenFox(settings) : null
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
      this.logger.warn('Failed to notify ask_user question', { error: String(error) })
    }
  }

  private async sendQuestion(session: SessionRef, question: PendingQuestion): Promise<void> {
    if (this.tokenByCallId.has(question.callId)) return
    const telegram = this.telegram!
    const token = this.newToken()
    const keyboard = this.settings?.interactiveReplies ? questionKeyboard(token, question) : undefined
    const text = formatQuestionMessage(question, session)
    const result = await telegram.sendMessage(this.settings!.chatId, text, keyboard)
    this.track({
      token,
      kind: 'question',
      sessionId: session.id,
      callId: question.callId,
      chatId: this.settings!.chatId,
      messageId: result.message_id,
      question,
      createdAt: this.now(),
    })
    this.logger.info('Sent ask_user question to Telegram', { callId: question.callId, sessionId: session.id })
  }

  private async sendConfirmation(session: SessionRef, confirmation: PendingConfirmation): Promise<void> {
    if (this.tokenByCallId.has(confirmation.callId)) return
    const telegram = this.telegram!
    const token = this.newToken()
    const keyboard = this.settings?.interactiveReplies ? confirmationKeyboard(token) : undefined
    const text = formatConfirmationMessage(confirmation, session)
    const result = await telegram.sendMessage(this.settings!.chatId, text, keyboard)
    this.track({
      token,
      kind: 'confirmation',
      sessionId: session.id,
      callId: confirmation.callId,
      chatId: this.settings!.chatId,
      messageId: result.message_id,
      confirmation,
      createdAt: this.now(),
    })
    this.logger.info('Sent path confirmation to Telegram', { callId: confirmation.callId, sessionId: session.id })
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
      const intervalMs = Math.max(5, this.settings?.pollIntervalSeconds ?? 10) * 1000
      await this.sleep(intervalMs)
      if (!this.running) break
      if (!this.configured() || !this.settings?.notifyOnPathConfirmation) continue
      try {
        await this.pollConfirmations()
      } catch (error) {
        this.logger.warn('Confirmation poll failed', { error: String(error) })
      }
    }
  }

  /** One polling pass — exposed for testing. */
  async pollConfirmations(): Promise<void> {
    if (!this.openfox) return
    const { sessions, pendingConfirmationsBySession } = await this.openfox.listSessionsWithConfirmations()
    const sessionById = new Map(sessions.map((session) => [session.id, session]))

    const stillPending = new Set<string>()
    for (const [sessionId, confirmations] of Object.entries(pendingConfirmationsBySession)) {
      const session = sessionById.get(sessionId) ?? { id: sessionId }
      for (const confirmation of confirmations) {
        stillPending.add(confirmation.callId)
        if (this.tokenByCallId.has(confirmation.callId)) continue
        try {
          await this.sendConfirmation(session, confirmation)
        } catch (error) {
          this.logger.warn('Failed to send confirmation', { error: String(error), callId: confirmation.callId })
        }
      }
    }
    this.purgeMissing(stillPending)
  }

  /** Drop tracked confirmations that are no longer pending. */
  private purgeMissing(stillPending: Set<string>): void {
    for (const pending of [...this.pendingByToken.values()]) {
      if (pending.kind !== 'confirmation') continue
      if (!stillPending.has(pending.callId)) this.untrack(pending.token)
    }
  }

  // --- incoming updates -------------------------------------------------------

  private async updatesLoop(): Promise<void> {
    while (this.running) {
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

  /** Edit the Telegram message to show the outcome and stop tracking it. */
  private async finalize(pending: PendingNotification, verdict: string): Promise<void> {
    this.untrack(pending.token)
    try {
      const base =
        pending.kind === 'confirmation'
          ? formatConfirmationMessage(pending.confirmation!, { id: pending.sessionId })
          : formatQuestionMessage(pending.question!, { id: pending.sessionId })
      await this.telegram!.editMessageText(pending.chatId, pending.messageId, `${base}\n\n<b>${escapeHtml(verdict)}</b>`)
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

  /** Send a plain test message; used by the RPC + settings button. */
  async sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
    if (!this.settings?.botToken || !this.settings.chatId) {
      return { ok: false, error: 'botToken et chatId sont requis' }
    }
    try {
      const client = this.telegram ?? this.createTelegram(this.settings)
      const me = await client.getMe()
      await client.sendMessage(
        this.settings.chatId,
        `✅ <b>OpenFox Telegram</b>\nConnexion réussie${me.username ? ` en tant que @${escapeHtml(me.username)}` : ''}.`,
      )
      return { ok: true }
    } catch (error) {
      const message =
        error instanceof TelegramApiError ? error.message : error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  /** Number of requests currently awaiting an answer (for diagnostics). */
  pendingCount(): number {
    return this.pendingByToken.size
  }
}

function defaultToken(): string {
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)]
  }
  return out
}
