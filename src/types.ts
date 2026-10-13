/**
 * Shared types for the OpenFox Telegram bridge plugin.
 */

export type AskQuestionType = 'text' | 'confirm' | 'choice'

export interface AskOption {
  value: string
  label: string
  description?: string
}

export interface PendingQuestion {
  callId: string
  question: string
  type: AskQuestionType
  options?: AskOption[]
}

export type PathConfirmationReason =
  | 'outside_workdir'
  | 'sensitive_file'
  | 'both'
  | 'dangerous_command'
  | 'git_no_verify'

export interface PendingConfirmation {
  callId: string
  tool: string
  paths: string[]
  workdir: string
  reason: PathConfirmationReason
}

export interface SessionRef {
  id: string
  title?: string
  workdir?: string
  projectId?: string
  isRunning?: boolean
  phase?: string
}

export interface SessionStatus {
  state: 'waiting' | 'blocked' | 'completed' | 'running' | null
}

export interface TelegramSettings {
  botToken: string
  chatId: string
  allowedUserIds: number[]
  openfoxBaseUrl: string
  sessionToken: string
  pollIntervalSeconds: number
  notifyOnAskUser: boolean
  notifyOnPathConfirmation: boolean
  interactiveReplies: boolean
  clearOnExternalAnswer: boolean
  includeSessionLink: boolean
  includeSessionState: boolean
}

/**
 * A request that was sent to Telegram and is still awaiting an answer.
 * The `token` is a short opaque id embedded in the inline keyboard so that
 * callback_data stays well below Telegram's 64-byte limit.
 */
export interface PendingNotification {
  token: string
  kind: 'question' | 'confirmation'
  sessionId: string
  callId: string
  chatId: string
  messageId: number
  question?: PendingQuestion
  confirmation?: PendingConfirmation
  projectId?: string
  sessionTitle?: string
  sessionState?: string | null
  createdAt: number
}
