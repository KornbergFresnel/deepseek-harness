/** Card JSON 2.0 documents the bridge sends: replies, prompts from other clients, permission requests, questions, and notices. */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { adaptMarkdown, codeBlock, truncate } from './markdown.ts'
import type { ApprovalButtonValue, FeishuCard, FeishuOpenId } from './types.ts'

/** Languages the card copy is written in. */
export type CardLocale = 'en' | 'zh'

const COPY = {
  en: {
    permissionTitle: 'Permission request',
    allowOnce: 'Allow once',
    reject: 'Reject',
    tool: 'Tool',
    reason: 'Reason',
    arguments: 'Arguments',
    allowedBy: 'Allowed by',
    rejectedBy: 'Rejected by',
    cancelled: 'The agent withdrew this request.',
    questionTitle: 'The agent has a question',
    submit: 'Submit',
    choose: 'Choose',
    other: 'Other answer (optional)',
    answer: 'Your answer',
    answeredBy: 'Answered by',
    continued: 'The agent stopped waiting. An answer submitted now reaches it as a new message.',
    closed: 'This question is closed.',
    answerAll: 'Answer every question before submitting.',
    thinking: 'Thinking',
    toolCalls: 'Tool calls',
    fromOther: 'Prompt sent from another client',
    part: 'Part',
    workspaceTitle: 'Choose a workspace',
    workspacePrompt: 'Choose the workspace of the new Session.',
    workspacePending: 'Your message is sent to the new Session once it starts.',
    createSession: 'Start Session',
    chooseWorkspace: 'Choose a workspace before starting.',
    startedIn: 'Started Session',
  },
  zh: {
    permissionTitle: '权限请求',
    allowOnce: '允许本次',
    reject: '拒绝',
    tool: '工具',
    reason: '原因',
    arguments: '参数',
    allowedBy: '已允许，操作人',
    rejectedBy: '已拒绝，操作人',
    cancelled: 'Agent 已撤回这个请求。',
    questionTitle: 'Agent 有问题要问你',
    submit: '提交',
    choose: '请选择',
    other: '其他回答（可选）',
    answer: '你的回答',
    answeredBy: '已回答，回答人',
    continued: 'Agent 已不再等待。现在提交的回答会作为一条新消息发给它。',
    closed: '这个问题已关闭。',
    answerAll: '请回答所有问题后再提交。',
    thinking: '思考过程',
    toolCalls: '工具调用',
    fromOther: '来自其他客户端的消息',
    part: '第',
    workspaceTitle: '选择工作区',
    workspacePrompt: '选择新会话使用的工作区。',
    workspacePending: '会话创建后会把你刚才的消息发给它。',
    createSession: '创建会话',
    chooseWorkspace: '请先选择工作区。',
    startedIn: '已创建会话',
  },
} as const satisfies Record<CardLocale, Record<string, string>>

/** Copy keys shared by every locale. */
export type CopyKey = keyof typeof COPY['en']

/**
 * Look up one card string.
 * @param locale - card language.
 * @param key - copy key.
 * @returns the localized string.
 */
export function copy(locale: CardLocale, key: CopyKey): string {
  return COPY[locale][key]
}

/** Plain text object used by headers, buttons, and inputs. */
function plain(content: string): { tag: 'plain_text'; content: string } {
  return { tag: 'plain_text', content }
}

/** Markdown element whose content is trusted card markup. */
function markdown(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag: 'markdown', content, ...extra }
}

/** Wrap body elements in a Card JSON 2.0 document. */
function card(elements: readonly unknown[], options: { header?: Record<string, unknown>; summary: string }): FeishuCard {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: truncate(options.summary.replace(/\s+/g, ' ').trim(), 60) },
    },
    ...options.header === undefined ? {} : { header: options.header },
    body: { elements },
  }
}

/** Collapsed panel holding secondary content. */
function panel(title: string, elements: readonly unknown[]): Record<string, unknown> {
  return { tag: 'collapsible_panel', expanded: false, header: { title: plain(title) }, elements }
}

/** One tool call requested in an assistant message. */
export interface CardToolCall {
  readonly name: string
  readonly arguments: string
}

/** One assistant message chunk and the material shown around it. */
export interface AssistantCardInput {
  /** Assistant Markdown for this chunk; already split to the card budget. */
  readonly text: string
  /** Reasoning shown collapsed above the text, on the first chunk only. */
  readonly reasoning?: string
  /** Tool calls shown collapsed below the text, on the last chunk only. */
  readonly toolCalls?: readonly CardToolCall[]
  /** One-based chunk position and total when the message was split. */
  readonly part?: { readonly index: number; readonly total: number }
  /** Maximum characters of one tool call's arguments. */
  readonly argumentLimit: number
}

/**
 * Render one assistant message chunk.
 * @param locale - card language.
 * @param input - chunk text and the reasoning and tool calls to show with it.
 * @returns the card, or undefined when nothing is visible.
 */
export function assistantCard(locale: CardLocale, input: AssistantCardInput): FeishuCard | undefined {
  const elements: unknown[] = []
  if (input.reasoning !== undefined && input.reasoning.trim() !== '') {
    elements.push(panel(copy(locale, 'thinking'), [markdown(adaptMarkdown(input.reasoning), { text_size: 'notation' })]))
  }
  if (input.text.trim() !== '') elements.push(markdown(adaptMarkdown(input.text)))
  if (input.toolCalls !== undefined && input.toolCalls.length > 0) {
    elements.push(panel(`${copy(locale, 'toolCalls')} (${String(input.toolCalls.length)})`, input.toolCalls.map(call => markdown(
      `**${escapeMarkup(call.name)}**\n${codeBlock(truncate(prettyArguments(call.arguments), input.argumentLimit), 'json')}`,
    ))))
  }
  if (elements.length === 0) return undefined
  if (input.part !== undefined) {
    elements.push(markdown(`<font color='grey'>${partLabel(locale, input.part)}</font>`, { text_size: 'notation' }))
  }
  return card(elements, { summary: input.text === '' ? copy(locale, 'toolCalls') : input.text })
}

/** Chunk position label. */
function partLabel(locale: CardLocale, part: { readonly index: number; readonly total: number }): string {
  return locale === 'zh'
    ? `第 ${String(part.index)}/${String(part.total)} 部分`
    : `${copy(locale, 'part')} ${String(part.index)}/${String(part.total)}`
}

/**
 * Render a prompt another client sent to the bound Session.
 * @param locale - card language.
 * @param text - the prompt's text.
 * @returns the card.
 */
export function userPromptCard(locale: CardLocale, text: string): FeishuCard {
  return card([
    markdown(`<font color='grey'>${copy(locale, 'fromOther')}</font>`, { text_size: 'notation' }),
    markdown(adaptMarkdown(text)),
  ], { summary: text })
}

/**
 * Render a short notice.
 * @param text - trusted card Markdown.
 * @param tone - `info` renders plain; `error` renders red.
 * @returns the card.
 */
export function noticeCard(text: string, tone: 'info' | 'error' = 'info'): FeishuCard {
  return card([markdown(tone === 'error' ? `<font color='red'>${text}</font>` : text)], { summary: text })
}

/** States a permission-request card shows. */
export type ApprovalCardState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'allowed' | 'rejected'; readonly operator: FeishuOpenId }
  | { readonly kind: 'cancelled' }

/** The facts a permission-request card shows. */
export interface ApprovalCardInput {
  readonly toolName: string
  readonly reason?: string
  /** Raw JSON arguments of the tool call, when the bridge saw it. */
  readonly arguments?: string
  readonly argumentLimit: number
}

/**
 * Render a permission request with Allow once and Reject buttons while it is pending.
 * @param locale - card language.
 * @param input - the tool, reason, and arguments.
 * @param state - pending, the decision and who made it, or withdrawn.
 * @returns the card.
 */
export function approvalCard(locale: CardLocale, input: ApprovalCardInput, state: ApprovalCardState): FeishuCard {
  const lines = [`**${copy(locale, 'tool')}**: \`${input.toolName.replaceAll('`', '')}\``]
  if (input.reason !== undefined && input.reason.trim() !== '') {
    lines.push(`**${copy(locale, 'reason')}**: ${adaptMarkdown(input.reason)}`)
  }
  const elements: unknown[] = [markdown(lines.join('\n'))]
  if (input.arguments !== undefined) {
    elements.push(markdown(`**${copy(locale, 'arguments')}**\n${codeBlock(truncate(prettyArguments(input.arguments), input.argumentLimit), 'json')}`))
  }
  switch (state.kind) {
    case 'pending':
      elements.push({
        tag: 'column_set',
        columns: [
          { tag: 'column', width: 'auto', elements: [button(copy(locale, 'allowOnce'), 'primary_filled', { dsh: 'approval', decision: 'allow' })] },
          { tag: 'column', width: 'auto', elements: [button(copy(locale, 'reject'), 'danger', { dsh: 'approval', decision: 'reject' })] },
        ],
      })
      break
    case 'allowed':
      elements.push(markdown(`<font color='green'>✅ ${copy(locale, 'allowedBy')}</font> <at id=${state.operator}></at>`))
      break
    case 'rejected':
      elements.push(markdown(`<font color='red'>⛔ ${copy(locale, 'rejectedBy')}</font> <at id=${state.operator}></at>`))
      break
    case 'cancelled':
      elements.push(markdown(`<font color='grey'>${copy(locale, 'cancelled')}</font>`))
      break
    /* v8 ignore next 2 -- closed union. */
    default:
      return assertNever(state, 'approval card state')
  }
  return card(elements, {
    header: {
      title: plain(copy(locale, 'permissionTitle')),
      subtitle: plain(input.toolName),
      template: state.kind === 'pending' ? 'orange' : state.kind === 'allowed' ? 'green' : 'grey',
    },
    summary: `${copy(locale, 'permissionTitle')}: ${input.toolName}`,
  })
}

/** A callback button. */
function button(text: string, type: string, value: ApprovalButtonValue): Record<string, unknown> {
  return { tag: 'button', text: plain(text), type, behaviors: [{ type: 'callback', value }] }
}

/** States a question card shows. */
export type QuestionCardState =
  | { readonly kind: 'pending'; readonly error?: boolean }
  | { readonly kind: 'continued'; readonly error?: boolean }
  | { readonly kind: 'answered'; readonly operator: FeishuOpenId; readonly answers: readonly AskUserQuestionAnswerItem[] }
  | { readonly kind: 'closed' }

/**
 * Form field name of one question's choice component.
 * @param index - zero-based question position.
 * @returns the field name.
 */
export function choiceField(index: number): string {
  return `q${String(index)}`
}

/**
 * Form field name of one question's free-text component.
 * @param index - zero-based question position.
 * @returns the field name.
 */
export function textField(index: number): string {
  return `q${String(index)}_text`
}

/**
 * Callback value of one option.
 * @param index - zero-based option position.
 * @returns the option value.
 */
export function optionValue(index: number): string {
  return `o${String(index)}`
}

/**
 * Render an `ask_user_question` request as one form, or the answers once given.
 * @param locale - card language.
 * @param questions - the asked questions.
 * @param state - open (in or after the agent's wait), answered, or closed.
 * @returns the card.
 */
export function questionCard(locale: CardLocale, questions: readonly AskUserQuestionItem[], state: QuestionCardState): FeishuCard {
  const elements: unknown[] = []
  const describe = (question: AskUserQuestionItem): string[] => {
    const lines = [`**${question.header === undefined ? '' : `${adaptMarkdown(question.header)} · `}${adaptMarkdown(question.question)}**`]
    if (question.detail !== undefined) lines.push(adaptMarkdown(question.detail))
    return lines
  }
  if (state.kind === 'pending' || state.kind === 'continued') {
    const form: unknown[] = []
    questions.forEach((question, index) => {
      form.push(markdown(describe(question).join('\n')))
      const options = question.options ?? []
      if (options.length > 0) {
        form.push({
          tag: question.multiSelect === true ? 'multi_select_static' : 'select_static',
          name: choiceField(index),
          placeholder: plain(copy(locale, 'choose')),
          width: 'fill',
          options: options.map((option, optionIndex) => ({
            text: plain(truncate(option.description === undefined ? option.label : `${option.label} — ${option.description}`, 100)),
            value: optionValue(optionIndex),
          })),
        })
      }
      form.push({
        tag: 'input',
        name: textField(index),
        width: 'fill',
        input_type: 'multiline_text',
        rows: 1,
        auto_resize: true,
        placeholder: plain(copy(locale, options.length > 0 ? 'other' : 'answer')),
      })
    })
    if (state.error === true) form.push(markdown(`<font color='red'>${copy(locale, 'answerAll')}</font>`))
    if (state.kind === 'continued') form.push(markdown(`<font color='grey'>${copy(locale, 'continued')}</font>`, { text_size: 'notation' }))
    form.push({ tag: 'button', name: 'submit', text: plain(copy(locale, 'submit')), type: 'primary_filled', form_action_type: 'submit' })
    elements.push({ tag: 'form', name: 'answer', elements: form })
  } else {
    for (const question of questions) {
      const lines = describe(question)
      if (state.kind === 'answered') {
        const answer = state.answers.find(item => item.id === question.id)
        const parts = [...answer?.selected ?? [], ...answer?.custom === undefined ? [] : [answer.custom]]
        lines.push(`> ${parts.map(adaptMarkdown).join(' · ')}`)
      }
      elements.push(markdown(lines.join('\n')))
    }
    elements.push(markdown(state.kind === 'answered'
      ? `<font color='green'>✅ ${copy(locale, 'answeredBy')}</font> <at id=${state.operator}></at>`
      : `<font color='grey'>${copy(locale, 'closed')}</font>`))
  }
  return card(elements, {
    header: { title: plain(copy(locale, 'questionTitle')), template: state.kind === 'answered' || state.kind === 'closed' ? 'grey' : 'blue' },
    summary: `${copy(locale, 'questionTitle')}: ${questions.map(question => question.question).join(' ')}`,
  })
}

/** Pretty-print JSON arguments; keep model output that is not JSON as written. */
function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch (_notJson) {
    return raw
  }
}

/** Escape characters the card markdown element reads as markup in a short identifier. */
function escapeMarkup(text: string): string {
  return text.replace(/[\\`*_~<>[\]]/g, char => `&#${String(char.charCodeAt(0))};`)
}

/** One workspace offered on a workspace picker card. */
export interface WorkspaceChoice {
  /** Workspace record identity, submitted as the option value. */
  readonly id: string
  /** Display title. */
  readonly title: string
  /** Canonical directory. */
  readonly path: string
}

/** State of a workspace picker card. */
export type WorkspaceCardState =
  | { readonly kind: 'pending'; readonly selectedId?: string; readonly error?: boolean; readonly stashed?: boolean }
  | { readonly kind: 'started'; readonly workspace: WorkspaceChoice; readonly sessionId: string; readonly operator: FeishuOpenId }

/** Form field holding the chosen workspace id. */
export const WORKSPACE_FIELD = 'workspace'

/**
 * Build a card that starts a Session in a chosen workspace.
 * @param locale - card language.
 * @param workspaces - registered workspaces, in offer order.
 * @param state - pending choice, or the started Session.
 * @returns the card.
 */
export function workspaceCard(locale: CardLocale, workspaces: readonly WorkspaceChoice[], state: WorkspaceCardState): FeishuCard {
  const elements: unknown[] = []
  switch (state.kind) {
    case 'pending': {
      const form: unknown[] = [markdown(copy(locale, 'workspacePrompt'))]
      form.push({
        tag: 'select_static',
        name: WORKSPACE_FIELD,
        placeholder: plain(copy(locale, 'choose')),
        width: 'fill',
        ...workspaces.some(workspace => workspace.id === state.selectedId) ? { initial_option: state.selectedId } : {},
        options: workspaces.map(workspace => ({ text: plain(truncate(`${workspace.title} — ${workspace.path}`, 100)), value: workspace.id })),
      })
      if (state.stashed === true) form.push(markdown(`<font color='grey'>${copy(locale, 'workspacePending')}</font>`, { text_size: 'notation' }))
      if (state.error === true) form.push(markdown(`<font color='red'>${copy(locale, 'chooseWorkspace')}</font>`))
      form.push({ tag: 'button', name: 'submit', text: plain(copy(locale, 'createSession')), type: 'primary_filled', form_action_type: 'submit' })
      elements.push({ tag: 'form', name: 'workspace', elements: form })
      break
    }
    case 'started':
      elements.push(markdown([
        `**${escapeMarkup(state.workspace.title)}** \`${state.workspace.path}\``,
        `<font color='green'>✅ ${copy(locale, 'startedIn')} \`${state.sessionId}\`</font> <at id=${state.operator}></at>`,
      ].join('\n')))
      break
    /* v8 ignore next 2 -- closed union. */
    default:
      return assertNever(state, 'workspace card state')
  }
  return card(elements, {
    header: { title: plain(copy(locale, 'workspaceTitle')), template: state.kind === 'pending' ? 'blue' : 'grey' },
    summary: copy(locale, 'workspaceTitle'),
  })
}
