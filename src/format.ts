/**
 * Message formatting + inline-keyboard / callback_data helpers.
 *
 * callback_data is limited to 64 bytes by Telegram, so a short opaque token
 * identifies the pending request while the action stays a single character.
 */

import type { InlineKeyboardMarkup } from './telegram-client.js'
import type { PendingConfirmation, PendingQuestion } from './types.js'

export type CallbackAction =
  | 'approve'
  | 'deny'
  | 'always'
  | 'skip'
  | 'answer'
  | 'noop'

export interface CallbackData {
  kind: 'question' | 'confirmation'
  token: string
  action: CallbackAction
}

const KIND_CODE: Record<CallbackData['kind'], string> = { question: 'q', confirmation: 'c' }
const KIND_BY_CODE: Record<string, CallbackData['kind']> = { q: 'question', c: 'confirmation' }

const ACTION_CODE: Record<CallbackAction, string> = {
  approve: 'a',
  deny: 'd',
  always: 'w',
  skip: 's',
  answer: 'k',
  noop: 'n',
}
const ACTION_BY_CODE: Record<string, CallbackAction> = Object.fromEntries(
  Object.entries(ACTION_CODE).map(([action, code]) => [code, action as CallbackAction]),
) as Record<string, CallbackAction>

export function encodeCallbackData(kind: CallbackData['kind'], token: string, action: CallbackAction): string {
  return `${KIND_CODE[kind]}:${token}:${ACTION_CODE[action]}`
}

export function decodeCallbackData(raw: string | undefined): CallbackData | null {
  if (!raw) return null
  const first = raw.indexOf(':')
  const last = raw.lastIndexOf(':')
  if (first === -1 || last === first) return null
  const kindCode = raw.slice(0, first)
  const token = raw.slice(first + 1, last)
  const actionCode = raw.slice(last + 1)
  const kind = KIND_BY_CODE[kindCode]
  const action = ACTION_BY_CODE[actionCode]
  if (!kind || !action || !token) return null
  return { kind, token, action }
}

/**
 * Split a callback token that may carry an option value
 * (`<shortId>#<optionValue>`) into its parts.
 */
export function splitQuestionToken(token: string): { id: string; optionValue?: string } {
  const hash = token.indexOf('#')
  if (hash === -1) return { id: token }
  return { id: token.slice(0, hash), optionValue: token.slice(hash + 1) }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const REASON_LABEL: Record<string, string> = {
  outside_workdir: 'Chemin hors du répertoire de travail',
  sensitive_file: 'Fichier sensible (peut contenir des secrets)',
  both: 'Chemin hors workdir et fichier sensible',
  dangerous_command: 'Commande dangereuse',
  git_no_verify: 'Commande git avec --no-verify',
}

/** French labels for the `state` returned by `GET /api/sessions/:id/status`. */
const STATUS_STATE_LABEL: Record<string, string> = {
  running: 'En cours',
  waiting: 'En attente',
  blocked: 'Bloquée',
  completed: 'Terminée',
}

export function statusStateLabel(state: string | null | undefined): string {
  return state ? (STATUS_STATE_LABEL[state] ?? '') : ''
}

/**
 * Label shown at send time: a forwarded question or confirmation always means
 * the session is waiting for the user, even though its summary still reports
 * `isRunning` (the turn resolves only after the request is answered).
 */
export const WAITING_SESSION_STATE = STATUS_STATE_LABEL['waiting']!

export interface SessionDisplay {
  id: string
  title?: string
}

export interface FormatOptions {
  sessionState?: string | null
  sessionLinkUrl?: string
}

function sessionHeader(session: SessionDisplay, options?: FormatOptions): string[] {
  const lines: string[] = []
  if (session.title) lines.push(`Session : <i>${escapeHtml(session.title)}</i>`)
  if (options?.sessionState) lines.push(`État : ${escapeHtml(options.sessionState)}`)
  if (options?.sessionLinkUrl) lines.push(`<a href="${escapeHtml(options.sessionLinkUrl)}">Ouvrir la session</a>`)
  return lines
}

export function formatQuestionMessage(
  question: PendingQuestion,
  session: SessionDisplay,
  options?: FormatOptions,
): string {
  const lines: string[] = []
  lines.push('❓ <b>OpenFox attend votre réponse</b>')
  lines.push(...sessionHeader(session, options))
  lines.push('')
  lines.push(escapeHtml(truncate(question.question, 3500)))
  return lines.join('\n')
}

export function formatConfirmationMessage(
  confirmation: PendingConfirmation,
  session: SessionDisplay,
  options?: FormatOptions,
): string {
  const lines: string[] = []
  lines.push('⚠️ <b>OpenFox demande une confirmation</b>')
  lines.push(...sessionHeader(session, options))
  lines.push('')
  lines.push(`Outil : <code>${escapeHtml(confirmation.tool)}</code>`)
  lines.push(`Motif : ${escapeHtml(REASON_LABEL[confirmation.reason] ?? confirmation.reason)}`)
  if (confirmation.paths.length > 0) {
    lines.push('')
    lines.push('<b>Chemins concernés :</b>')
    for (const path of confirmation.paths.slice(0, 20)) {
      lines.push(`• <code>${escapeHtml(truncate(path, 300))}</code>`)
    }
  }
  return lines.join('\n')
}

export function questionKeyboard(token: string, question: PendingQuestion): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup['inline_keyboard'] = []
  if (question.type === 'choice' && question.options && question.options.length > 0) {
    for (const option of question.options.slice(0, 20)) {
      rows.push([
        {
          text: truncate(option.label, 60),
          callback_data: encodeCallbackData('question', `${token}#${option.value}`.slice(0, 40), 'answer'),
        },
      ])
    }
  } else if (question.type === 'confirm') {
    rows.push([
      { text: '✅ Oui', callback_data: encodeCallbackData('question', token, 'approve') },
      { text: '❌ Non', callback_data: encodeCallbackData('question', token, 'deny') },
    ])
  } else {
    rows.push([
      { text: '⏭️ Ignorer', callback_data: encodeCallbackData('question', token, 'skip') },
    ])
  }
  return { inline_keyboard: rows }
}

export function emptyKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [] }
}

export function confirmationKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approuver', callback_data: encodeCallbackData('confirmation', token, 'approve') },
        { text: '❌ Refuser', callback_data: encodeCallbackData('confirmation', token, 'deny') },
      ],
      [
        { text: '🔓 Toujours autoriser', callback_data: encodeCallbackData('confirmation', token, 'always') },
      ],
    ],
  }
}
