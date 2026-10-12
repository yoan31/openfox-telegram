import { describe, it, expect, vi } from 'vitest'
import { TelegramBridge } from './bridge.js'
import type { TelegramClient, TelegramUpdate } from './telegram-client.js'
import type { OpenFoxClient } from './openfox-client.js'
import { OpenFoxApiError } from './openfox-client.js'
import type { PendingConfirmation, PendingQuestion, TelegramSettings } from './types.js'

const BASE_SETTINGS: TelegramSettings = {
  botToken: 'token',
  chatId: '100',
  allowedUserIds: [],
  openfoxBaseUrl: 'http://127.0.0.1:10369',
  sessionToken: '',
  pollIntervalSeconds: 10,
  notifyOnAskUser: true,
  notifyOnPathConfirmation: true,
  interactiveReplies: true,
  clearOnExternalAnswer: true,
}

interface SentMessage {
  chatId: string
  text: string
  keyboard?: unknown
  messageId: number
}

class FakeTelegram {
  sent: SentMessage[] = []
  edited: Array<{ chatId: string; messageId: number; text: string; keyboard?: unknown }> = []
  deleted: Array<{ chatId: string; messageId: number }> = []
  answered: string[] = []
  deleteShouldFail = false
  private nextId = 1000

  async sendMessage(chatId: string, text: string, keyboard?: unknown): Promise<{ message_id: number }> {
    this.nextId += 1
    this.sent.push({ chatId, text, keyboard, messageId: this.nextId })
    return { message_id: this.nextId }
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    if (this.deleteShouldFail) throw new Error('deleteMessage failed')
    this.deleted.push({ chatId, messageId })
  }

  async editMessageText(chatId: string, messageId: number, text: string, keyboard?: unknown): Promise<void> {
    this.edited.push({ chatId, messageId, text, keyboard })
  }

  async answerCallbackQuery(_id: string, text?: string): Promise<void> {
    this.answered.push(text ?? '')
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return []
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return { id: 1, username: 'bot' }
  }
}

class FakeOpenFox {
  sessions: Array<{ id: string; title?: string }> = []
  confirmations: Record<string, PendingConfirmation[]> = {}
  questions: Record<string, PendingQuestion[]> = {}
  answered: Array<{ sessionId: string; callId: string; answer: string }> = []
  confirmed: Array<{ sessionId: string; callId: string; approved: boolean; alwaysAllow: boolean }> = []

  async listSessionsWithConfirmations(): Promise<{
    sessions: Array<{ id: string; title?: string }>
    pendingConfirmationsBySession: Record<string, PendingConfirmation[]>
  }> {
    return { sessions: this.sessions, pendingConfirmationsBySession: this.confirmations }
  }

  async getSession(sessionId: string): Promise<{
    session: { id: string; title?: string }
    pendingQuestions: PendingQuestion[]
    pendingConfirmations: PendingConfirmation[]
  }> {
    return {
      session: this.sessions.find((s) => s.id === sessionId) ?? { id: sessionId },
      pendingQuestions: this.questions[sessionId] ?? [],
      pendingConfirmations: this.confirmations[sessionId] ?? [],
    }
  }

  async answerQuestion(sessionId: string, callId: string, answer: string): Promise<boolean> {
    this.answered.push({ sessionId, callId, answer })
    return true
  }

  async confirmPath(sessionId: string, callId: string, approved: boolean, alwaysAllow = false): Promise<boolean> {
    this.confirmed.push({ sessionId, callId, approved, alwaysAllow })
    return true
  }
}

function createBridge(
  settings: Partial<TelegramSettings> = {},
  now: () => number = () => Date.now(),
): {
  bridge: TelegramBridge
  telegram: FakeTelegram
  openfox: FakeOpenFox
} {
  const telegram = new FakeTelegram()
  const openfox = new FakeOpenFox()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const bridge = new TelegramBridge({
    logger,
    createTelegram: () => telegram as unknown as TelegramClient,
    createOpenFox: () => openfox as unknown as OpenFoxClient,
    now,
  })
  bridge.configure({ ...BASE_SETTINGS, ...settings })
  return { bridge, telegram, openfox }
}

describe('TelegramBridge — outgoing questions', () => {
  it('sends an ask_user question on turn.completed with reason waiting_for_user', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.sessions = [{ id: 's1', title: 'Session 1' }]
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'confirm' }] }

    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    expect(telegram.sent).toHaveLength(1)
    expect(telegram.sent[0]!.text).toContain('Continue?')
    expect(bridge.pendingCount()).toBe(1)
  })

  it('ignores turn.completed for other reasons', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'x', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'complete' } })
    expect(telegram.sent).toHaveLength(0)
  })

  it('never sends the same callId twice (anti-duplicate)', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'x', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })
    expect(telegram.sent).toHaveLength(1)
  })

  it('does not notify when notifyOnAskUser is disabled', async () => {
    const { bridge, telegram, openfox } = createBridge({ notifyOnAskUser: false })
    openfox.questions = { s1: [{ callId: 'q1', question: 'x', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })
    expect(telegram.sent).toHaveLength(0)
  })
})

describe('TelegramBridge — confirmations', () => {
  it('sends new confirmations and purges resolved ones', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.sessions = [{ id: 's1' }]
    openfox.confirmations = {
      s1: [{ callId: 'c1', tool: 'run_command', paths: ['/etc/passwd'], workdir: '/w', reason: 'sensitive_file' }],
    }
    await bridge.pollConfirmations()
    expect(telegram.sent).toHaveLength(1)
    expect(bridge.pendingCount()).toBe(1)

    // Confirmation resolved upstream -> next poll clears it, no duplicate send.
    openfox.confirmations = {}
    await bridge.pollConfirmations()
    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.deleted).toEqual([{ chatId: '100', messageId: telegram.sent[0]!.messageId }])
  })
})

describe('TelegramBridge — clearing messages answered in OpenFox', () => {
  it('deletes the Telegram message when a question is answered in OpenFox', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })
    expect(bridge.pendingCount()).toBe(1)

    // Answered directly in OpenFox -> no longer pending upstream.
    openfox.questions = {}
    await bridge.pollConfirmations()

    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.deleted).toEqual([{ chatId: '100', messageId: telegram.sent[0]!.messageId }])
    expect(telegram.edited).toHaveLength(0)
  })

  it('deletes the Telegram message when a confirmation is answered in OpenFox', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.confirmations = {
      s1: [{ callId: 'c1', tool: 'run_command', paths: ['/x'], workdir: '/w', reason: 'outside_workdir' }],
    }
    await bridge.pollConfirmations()

    openfox.confirmations = {}
    await bridge.pollConfirmations()

    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.deleted).toHaveLength(1)
  })

  it('falls back to editing when deletion fails', async () => {
    const { bridge, telegram, openfox } = createBridge()
    telegram.deleteShouldFail = true
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    openfox.questions = {}
    await bridge.pollConfirmations()

    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.deleted).toHaveLength(0)
    expect(telegram.edited).toHaveLength(1)
    expect(telegram.edited[0]!.text).toContain('Répondu sur OpenFox')
  })

  it('does not delete when clearOnExternalAnswer is disabled', async () => {
    const { bridge, telegram, openfox } = createBridge({ clearOnExternalAnswer: false })
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    openfox.questions = {}
    await bridge.pollConfirmations()

    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.deleted).toHaveLength(0)
    expect(telegram.edited).toHaveLength(0)
  })

  it('does not delete a message answered through Telegram', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'Name?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    await bridge.handleUpdate({
      update_id: 1,
      message: { message_id: 5, chat: { id: 100 }, from: { id: 7 }, text: 'Conrad' },
    })
    openfox.questions = {}
    await bridge.pollConfirmations()

    expect(telegram.deleted).toHaveLength(0)
    expect(bridge.pendingCount()).toBe(0)
  })

  it('keeps tracking when the session cannot be read', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    openfox.getSession = async () => {
      throw new Error('HTTP 500')
    }
    await bridge.pollConfirmations()

    expect(bridge.pendingCount()).toBe(1)
    expect(telegram.deleted).toHaveLength(0)
  })

  it('clears notifications when the session is gone (404)', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    openfox.getSession = async () => {
      throw new OpenFoxApiError('OpenFox GET /api/sessions/s1 failed with HTTP 404', 404)
    }
    await bridge.pollConfirmations()

    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.deleted).toHaveLength(1)
  })

  it('drops a notification whose session stays unreadable past the max age', async () => {
    let clock = 0
    const { bridge, telegram, openfox } = createBridge({}, () => clock)
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    openfox.getSession = async () => {
      throw new Error('HTTP 500')
    }

    clock = 23 * 60 * 60 * 1000
    await bridge.pollConfirmations()
    expect(bridge.pendingCount()).toBe(1)

    clock = 25 * 60 * 60 * 1000
    await bridge.pollConfirmations()
    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.deleted).toHaveLength(0)
  })

  it('strips the inline keyboard when editing a resolved message', async () => {
    const { bridge, telegram, openfox } = createBridge()
    telegram.deleteShouldFail = true
    openfox.questions = { s1: [{ callId: 'q1', question: 'Continue?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    openfox.questions = {}
    await bridge.pollConfirmations()

    expect(telegram.edited).toHaveLength(1)
    expect(telegram.edited[0]!.keyboard).toEqual({ inline_keyboard: [] })
  })

  it('strips the inline keyboard when finalizing a Telegram answer', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'Name?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    await bridge.handleUpdate({
      update_id: 1,
      message: { message_id: 5, chat: { id: 100 }, from: { id: 7 }, text: 'Conrad' },
    })

    expect(telegram.edited).toHaveLength(1)
    expect(telegram.edited[0]!.keyboard).toEqual({ inline_keyboard: [] })
  })

  it('does not read the session again for confirmations', async () => {
    const { bridge, openfox } = createBridge()
    let reads = 0
    const original = openfox.getSession.bind(openfox)
    openfox.getSession = async (sessionId: string) => {
      reads += 1
      return original(sessionId)
    }
    openfox.confirmations = {
      s1: [{ callId: 'c1', tool: 'run_command', paths: ['/x'], workdir: '/w', reason: 'outside_workdir' }],
    }
    await bridge.pollConfirmations()

    expect(reads).toBe(0)
  })
})

describe('TelegramBridge — incoming replies', () => {
  it('routes a confirmation button to confirm-path', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.confirmations = {
      s1: [{ callId: 'c1', tool: 'run_command', paths: ['/x'], workdir: '/w', reason: 'outside_workdir' }],
    }
    await bridge.pollConfirmations()
    const keyboard = telegram.sent[0]!.keyboard as { inline_keyboard: { callback_data: string }[][] }
    const data = keyboard.inline_keyboard[1]![0]!.callback_data

    await bridge.handleUpdate({
      update_id: 1,
      callback_query: { id: 'cb1', from: { id: 7 }, data, message: { message_id: 1001, chat: { id: 100 } } },
    })

    expect(openfox.confirmed).toEqual([{ sessionId: 's1', callId: 'c1', approved: true, alwaysAllow: true }])
    expect(bridge.pendingCount()).toBe(0)
    expect(telegram.edited).toHaveLength(1)
  })

  it('routes a choice question button to answer', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.questions = {
      s1: [{ callId: 'q1', question: 'Pick', type: 'choice', options: [{ value: 'a', label: 'A' }] }],
    }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })
    const keyboard = telegram.sent[0]!.keyboard as { inline_keyboard: { callback_data: string }[][] }
    const data = keyboard.inline_keyboard[0]![0]!.callback_data

    await bridge.handleUpdate({
      update_id: 2,
      callback_query: { id: 'cb2', from: { id: 7 }, data, message: { message_id: 1001, chat: { id: 100 } } },
    })

    expect(openfox.answered).toEqual([{ sessionId: 's1', callId: 'q1', answer: 'a' }])
    expect(bridge.pendingCount()).toBe(0)
  })

  it('routes a free-text reply to the latest text question', async () => {
    const { bridge, openfox } = createBridge()
    openfox.questions = { s1: [{ callId: 'q1', question: 'Name?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    await bridge.handleUpdate({
      update_id: 3,
      message: { message_id: 5, chat: { id: 100 }, from: { id: 7 }, text: 'Conrad' },
    })

    expect(openfox.answered).toEqual([{ sessionId: 's1', callId: 'q1', answer: 'Conrad' }])
    expect(bridge.pendingCount()).toBe(0)
  })

  it('ignores replies from non-allowed users', async () => {
    const { bridge, openfox } = createBridge({ allowedUserIds: [999] })
    openfox.questions = { s1: [{ callId: 'q1', question: 'Name?', type: 'text' }] }
    await bridge.onTurnCompleted({ sessionId: 's1', data: { reason: 'waiting_for_user' } })

    await bridge.handleUpdate({
      update_id: 4,
      message: { message_id: 6, chat: { id: 100 }, from: { id: 7 }, text: 'Conrad' },
    })

    expect(openfox.answered).toHaveLength(0)
    expect(bridge.pendingCount()).toBe(1)
  })

  it('answers expired callbacks without crashing', async () => {
    const { bridge, telegram } = createBridge()
    await bridge.handleUpdate({
      update_id: 5,
      callback_query: {
        id: 'cb9',
        from: { id: 7 },
        data: 'c:unknown1:a',
        message: { message_id: 1, chat: { id: 100 } },
      },
    })
    expect(telegram.answered).toEqual(['Demande expirée'])
  })
})

describe('TelegramBridge — connection test', () => {
  it('reports success when Telegram and OpenFox both respond', async () => {
    const { bridge } = createBridge()
    await expect(bridge.testConnection()).resolves.toEqual({ ok: true })
  })

  it('fails with a Telegram-prefixed error when Telegram is unconfigured', async () => {
    const { bridge } = createBridge({ botToken: '', chatId: '' })
    const result = await bridge.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Telegram')
  })

  it('fails with an OpenFox-prefixed error when the OpenFox API is unreachable', async () => {
    const { bridge, openfox } = createBridge()
    openfox.listSessionsWithConfirmations = async () => {
      throw new Error('HTTP 500')
    }
    const result = await bridge.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('OpenFox')
    expect(result.error).toContain('HTTP 500')
  })

  it('does not send a Telegram message when the OpenFox probe fails', async () => {
    const { bridge, telegram, openfox } = createBridge()
    openfox.listSessionsWithConfirmations = async () => {
      throw new Error('HTTP 500')
    }
    await bridge.testConnection()
    expect(telegram.sent).toHaveLength(0)
  })

  it('sends a test message mentioning the bot username', async () => {
    const { bridge, telegram } = createBridge()
    await bridge.testTelegram()
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.sent[0]!.text).toContain('@bot')
    expect(telegram.sent[0]!.text.toLowerCase()).toContain('test')
  })
})

describe('TelegramBridge — lifecycle', () => {
  it('start/stop toggles the running flag idempotently', () => {
    const { bridge } = createBridge()
    expect(bridge.isRunning()).toBe(false)
    bridge.start()
    bridge.start()
    expect(bridge.isRunning()).toBe(true)
    bridge.stop()
    bridge.stop()
    expect(bridge.isRunning()).toBe(false)
  })
})
