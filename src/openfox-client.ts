/**
 * Read/act client for the local OpenFox REST API.
 *
 * Only the endpoints needed by the Telegram bridge are implemented:
 * listing sessions (to detect pending confirmations), reading one session
 * (to fetch pending questions), and answering questions / confirmations.
 */

import type { FetchLike } from './telegram-client.js'
import type { PendingConfirmation, PendingQuestion, SessionRef, SessionStatus } from './types.js'

export interface OpenFoxClientOptions {
  baseUrl: string
  sessionToken?: string
  fetchImpl?: FetchLike
}

export class OpenFoxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'OpenFoxApiError'
  }
}

interface SessionsResponse {
  sessions: SessionRef[]
  pendingConfirmationsBySession?: Record<string, PendingConfirmation[]>
}

interface SessionResponse {
  session: SessionRef
  pendingQuestions?: PendingQuestion[]
  pendingConfirmations?: PendingConfirmation[]
}

export class OpenFoxClient {
  private readonly baseUrl: string
  private readonly sessionToken: string | undefined
  private readonly fetchImpl: FetchLike

  constructor(options: OpenFoxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.sessionToken = options.sessionToken && options.sessionToken !== '' ? options.sessionToken : undefined
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.sessionToken) headers['x-session-token'] = this.sessionToken
    return headers
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() })
    if (!response.ok) {
      throw new OpenFoxApiError(`OpenFox GET ${path} failed with HTTP ${response.status}`, response.status)
    }
    return (await response.json()) as T
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<{ status: number }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    return { status: response.status }
  }

  /** All sessions with their pending path confirmations (if any). */
  async listSessionsWithConfirmations(): Promise<{
    sessions: SessionRef[]
    pendingConfirmationsBySession: Record<string, PendingConfirmation[]>
  }> {
    const data = await this.getJson<SessionsResponse>('/api/sessions')
    return {
      sessions: data.sessions ?? [],
      pendingConfirmationsBySession: data.pendingConfirmationsBySession ?? {},
    }
  }

  /** One session with its pending questions and confirmations. */
  async getSession(
    sessionId: string,
  ): Promise<{ session: SessionRef; pendingQuestions: PendingQuestion[]; pendingConfirmations: PendingConfirmation[] }> {
    const data = await this.getJson<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    return {
      session: data.session,
      pendingQuestions: data.pendingQuestions ?? [],
      pendingConfirmations: data.pendingConfirmations ?? [],
    }
  }

  /**
   * Lightweight read-only status projection (`GET /api/sessions/:id/status`).
   * Returns the derived `state` (`running | waiting | blocked | completed | null`).
   */
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    return this.getJson<SessionStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/status`)
  }

  /** Answer a pending `ask_user` question. */
  async answerQuestion(sessionId: string, callId: string, answer: string): Promise<boolean> {
    const { status } = await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
      callId,
      answer,
    })
    return status >= 200 && status < 300
  }

  /** Resolve a pending path confirmation. */
  async confirmPath(
    sessionId: string,
    callId: string,
    approved: boolean,
    alwaysAllow = false,
  ): Promise<boolean> {
    const { status } = await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/confirm-path`, {
      callId,
      approved,
      alwaysAllow,
    })
    return status >= 200 && status < 300
  }
}
