import { describe, it, expect } from 'vitest'
import {
  confirmationKeyboard,
  decodeCallbackData,
  encodeCallbackData,
  escapeHtml,
  formatConfirmationMessage,
  formatQuestionMessage,
  questionKeyboard,
  splitQuestionToken,
} from './format.js'
import type { PendingConfirmation, PendingQuestion } from './types.js'

describe('callback data', () => {
  it('round-trips a simple token', () => {
    const encoded = encodeCallbackData('confirmation', 'aB12cd', 'always')
    expect(encoded.length).toBeLessThanOrEqual(64)
    expect(decodeCallbackData(encoded)).toEqual({ kind: 'confirmation', token: 'aB12cd', action: 'always' })
  })

  it('round-trips a question token carrying an option value', () => {
    const token = 'aB12cd#do-it-now'
    const encoded = encodeCallbackData('question', token, 'answer')
    const decoded = decodeCallbackData(encoded)
    expect(decoded).toEqual({ kind: 'question', token, action: 'answer' })
    expect(splitQuestionToken(decoded!.token)).toEqual({ id: 'aB12cd', optionValue: 'do-it-now' })
  })

  it('returns null for malformed payloads', () => {
    expect(decodeCallbackData(undefined)).toBeNull()
    expect(decodeCallbackData('nonsense')).toBeNull()
    expect(decodeCallbackData('x:y:z')).toBeNull()
  })
})

describe('message formatting', () => {
  it('escapes HTML in questions', () => {
    const question: PendingQuestion = { callId: '1', question: '<b>hi</b> & bye', type: 'text' }
    const text = formatQuestionMessage(question, { id: 's1', title: 'My <session>' })
    expect(text).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; bye')
    expect(text).toContain('My &lt;session&gt;')
    expect(text).toContain('OpenFox attend votre réponse')
  })

  it('lists paths and reason for a confirmation', () => {
    const confirmation: PendingConfirmation = {
      callId: 'c1',
      tool: 'run_command',
      paths: ['/etc/passwd', '/tmp/x'],
      workdir: '/work',
      reason: 'sensitive_file',
    }
    const text = formatConfirmationMessage(confirmation, { id: 's1' })
    expect(text).toContain('run_command')
    expect(text).toContain('/etc/passwd')
    expect(text).toContain('Fichier sensible')
  })

  it('escapes html helper', () => {
    expect(escapeHtml('<a> & "b"')).toBe('&lt;a&gt; &amp; "b"')
  })
})

describe('keyboards', () => {
  it('renders one row per choice option', () => {
    const question: PendingQuestion = {
      callId: 'q1',
      question: 'Pick',
      type: 'choice',
      options: [
        { value: 'a', label: 'Option A' },
        { value: 'b', label: 'Option B' },
      ],
    }
    const keyboard = questionKeyboard('tok1234567', question)
    expect(keyboard.inline_keyboard).toHaveLength(2)
    const decoded = decodeCallbackData(keyboard.inline_keyboard[0]![0]!.callback_data)
    expect(decoded?.action).toBe('answer')
    expect(splitQuestionToken(decoded!.token).optionValue).toBe('a')
  })

  it('renders yes/no for confirm questions', () => {
    const keyboard = questionKeyboard('tok1234567', { callId: 'q', question: 'ok?', type: 'confirm' })
    expect(keyboard.inline_keyboard[0]).toHaveLength(2)
    expect(decodeCallbackData(keyboard.inline_keyboard[0]![0]!.callback_data)?.action).toBe('approve')
    expect(decodeCallbackData(keyboard.inline_keyboard[0]![1]!.callback_data)?.action).toBe('deny')
  })

  it('renders approve/deny/always for confirmations', () => {
    const keyboard = confirmationKeyboard('tok1234567')
    expect(keyboard.inline_keyboard).toHaveLength(2)
    expect(decodeCallbackData(keyboard.inline_keyboard[1]![0]!.callback_data)?.action).toBe('always')
  })
})
