import { describe, it, expect, vi } from 'vitest'
import { TelegramApiError, TelegramClient } from './telegram-client.js'
import { OpenFoxApiError, OpenFoxClient } from './openfox-client.js'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>

function makeFetch(body: unknown, status = 200): FetchMock {
  return vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(body, status))
}

describe('TelegramClient', () => {
  it('posts sendMessage with HTML parse mode', async () => {
    const fetchImpl = makeFetch({ ok: true, result: { message_id: 7 } })
    const client = new TelegramClient({ token: 'tok', fetchImpl })

    const result = await client.sendMessage('100', 'hi')

    expect(result.message_id).toBe(7)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toContain('/bottok/sendMessage')
    expect(JSON.parse(String(init!.body))).toMatchObject({ chat_id: '100', text: 'hi', parse_mode: 'HTML' })
  })

  it('posts deleteMessage with chat and message id', async () => {
    const fetchImpl = makeFetch({ ok: true, result: true })
    const client = new TelegramClient({ token: 'tok', fetchImpl })

    await client.deleteMessage('100', 42)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toContain('/bottok/deleteMessage')
    expect(JSON.parse(String(init!.body))).toEqual({ chat_id: '100', message_id: 42 })
  })

  it('throws a TelegramApiError with retry_after on 429', async () => {
    const fetchImpl = makeFetch(
      { ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } },
      429,
    )
    const client = new TelegramClient({ token: 'tok', fetchImpl })

    await expect(client.getUpdates(0, 25)).rejects.toMatchObject({ name: 'TelegramApiError', retryAfterSeconds: 5 })
  })

  it('sends getUpdates with offset and allowed_updates', async () => {
    const fetchImpl = makeFetch({ ok: true, result: [] })
    const client = new TelegramClient({ token: 'tok', fetchImpl })

    await client.getUpdates(42, 25)

    const [, init] = fetchImpl.mock.calls[0]!
    expect(JSON.parse(String(init!.body))).toMatchObject({ offset: 42, timeout: 25 })
  })
})

describe('OpenFoxClient', () => {
  it('adds the session token header when configured', async () => {
    const fetchImpl = makeFetch({ sessions: [], pendingConfirmationsBySession: {} })
    const client = new OpenFoxClient({ baseUrl: 'http://127.0.0.1:10369/', sessionToken: 'abc', fetchImpl })

    await client.listSessionsWithConfirmations()

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:10369/api/sessions')
    expect((init!.headers as Record<string, string>)['x-session-token']).toBe('abc')
  })

  it('posts an answer to /answer', async () => {
    const fetchImpl = makeFetch({ success: true })
    const client = new OpenFoxClient({ baseUrl: 'http://127.0.0.1:10369', fetchImpl })

    const ok = await client.answerQuestion('s1', 'q1', 'yes')

    expect(ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toContain('/api/sessions/s1/answer')
    expect(JSON.parse(String(init!.body))).toEqual({ callId: 'q1', answer: 'yes' })
  })

  it('posts a confirmation to /confirm-path', async () => {
    const fetchImpl = makeFetch({ success: true })
    const client = new OpenFoxClient({ baseUrl: 'http://127.0.0.1:10369', fetchImpl })

    const ok = await client.confirmPath('s1', 'c1', true, true)

    expect(ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toContain('/api/sessions/s1/confirm-path')
    expect(JSON.parse(String(init!.body))).toEqual({ callId: 'c1', approved: true, alwaysAllow: true })
  })

  it('does not send an auth header when no token is set', async () => {
    const fetchImpl = makeFetch({ session: { id: 's1' }, pendingQuestions: [] })
    const client = new OpenFoxClient({ baseUrl: 'http://127.0.0.1:10369', fetchImpl })

    await client.getSession('s1')

    const [, init] = fetchImpl.mock.calls[0]!
    expect((init!.headers as Record<string, string>)['x-session-token']).toBeUndefined()
  })
})

describe('TelegramApiError', () => {
  it('exposes status and retryAfterSeconds', () => {
    const error = new TelegramApiError('boom', 500)
    expect(error.status).toBe(500)
    expect(error.name).toBe('TelegramApiError')
  })
})

describe('OpenFoxApiError', () => {
  it('exposes the HTTP status', async () => {
    const fetchImpl = makeFetch({ error: 'not found' }, 404)
    const client = new OpenFoxClient({ baseUrl: 'http://127.0.0.1:10369', fetchImpl })

    await expect(client.getSession('s1')).rejects.toMatchObject({ name: 'OpenFoxApiError', status: 404 })
    expect(new OpenFoxApiError('x', 500).status).toBe(500)
  })
})
