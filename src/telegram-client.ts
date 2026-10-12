/**
 * Minimal Telegram Bot API client.
 *
 * `fetchImpl` is injectable so unit tests never touch the network.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TelegramApiOptions {
  token: string
  fetchImpl?: FetchLike
  baseUrl?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    from?: { id: number }
    text?: string
  }
  callback_query?: {
    id: string
    from: { id: number }
    message?: { message_id: number; chat: { id: number } }
    data?: string
  }
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export interface SendMessageResult {
  message_id: number
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  parameters?: { retry_after?: number }
}

export class TelegramClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(options: TelegramApiOptions) {
    this.token = options.token
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org'
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    let payload: TelegramResponse<T> | undefined
    try {
      payload = (await response.json()) as TelegramResponse<T>
    } catch {
      payload = undefined
    }

    if (!response.ok || !payload || payload.ok !== true) {
      const description = payload?.description ?? `HTTP ${response.status}`
      throw new TelegramApiError(description, response.status, payload?.parameters?.retry_after)
    }
    return payload.result as T
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call<{ id: number; username?: string }>('getMe', {})
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<SendMessageResult> {
    return this.call<SendMessageResult>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    })
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    })
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    })
  }
}
