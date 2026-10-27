import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { approvalCard, assistantCard, noticeCard, questionCard, userPromptCard } from '../src/cards.ts'
import { BRIDGE_COMMANDS, HELP, parseBridgeCommand } from '../src/commands.ts'
import { parseAnswers } from '../src/index.ts'
import { adaptMarkdown, codeBlock, splitMarkdown, truncate } from '../src/markdown.ts'
import type { FeishuOpenId } from '../src/types.ts'

const OPERATOR = brandString<FeishuOpenId>('ou_alice')

/** Collect every element of a card body, descending into panels, columns, and forms. */
function elementsOf(card: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items as Record<string, unknown>[]) {
      out.push(item)
      visit(item['elements'])
      visit(item['columns'])
    }
  }
  visit((card['body'] as { elements: unknown }).elements)
  return out
}

describe('markdown adaptation', () => {
  it('escapes tags and turns images into links outside code only', () => {
    expect(adaptMarkdown('a <b> `<c>` ![x](https://i/p.png) ![y](local.png) ![](http://u)\r\n```html\n<div>\n```\n~~~\n<i>\n~~~')).toBe(
      'a &#60;b> `<c>` [x](https://i/p.png) y [http://u](http://u)\n```html\n<div>\n```\n~~~\n<i>\n~~~',
    )
    expect(adaptMarkdown('````\n```\n<x>\n````\n<y>')).toBe('````\n```\n<x>\n````\n&#60;y>')
  })

  it('splits long Markdown at lines and carries an open fence across chunks', () => {
    expect(splitMarkdown('short', 10)).toEqual(['short'])
    const text = ['intro line', '```py', ...Array.from({ length: 6 }, (_, i) => `print(${String(i)})`), '```', 'tail'].join('\n')
    const chunks = splitMarkdown(text, 40)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40)
    expect(chunks[0]?.startsWith('intro line\n```py')).toBe(true)
    expect(chunks.slice(0, -1).every(chunk => chunk.endsWith('```'))).toBe(true)
    expect(chunks.slice(1).every(chunk => chunk.startsWith('```py') || chunk === 'tail' || chunk.endsWith('tail'))).toBe(true)
    expect(chunks.join('\n')).toContain('print(5)')
    const wrapped = splitMarkdown('x'.repeat(25), 10)
    expect(wrapped).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
    const tilde = splitMarkdown(['~~~', 'a'.repeat(8), 'a'.repeat(8), '~~~~', 'b'].join('\n'), 16)
    expect(splitMarkdown('````\n```py\nx\n````\ny', 16)).toEqual(['````\n```py\n````', '````\nx\n````', '````\n````\ny'])
    expect(tilde).toEqual(['~~~\naaaaaaaa\n~~~', '~~~\naaaaaaaa\n~~~', '~~~\n~~~~\nb'])
  })

  it('bounds text and fences code containing backticks', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
    expect(codeBlock('a ``` b', 'json')).toBe('````json\na ``` b\n````')
    expect(codeBlock('plain')).toBe('```\nplain\n```')
  })
})

describe('cards', () => {
  it('renders replies with collapsed reasoning, tool calls, and part labels', () => {
    const card = assistantCard('en', {
      text: '**Done** <ok>',
      reasoning: 'thinking',
      toolCalls: [{ name: 'bash_*', arguments: '{"command":"ls"}' }, { name: 'raw', arguments: 'not json' }],
      part: { index: 2, total: 3 },
      argumentLimit: 100,
    })
    expect(card).toMatchObject({ schema: '2.0', config: { update_multi: true, summary: { content: '**Done** <ok>' } } })
    const elements = elementsOf(card!)
    expect(elements.map(element => element['tag'])).toEqual(['collapsible_panel', 'markdown', 'markdown', 'collapsible_panel', 'markdown', 'markdown', 'markdown'])
    expect(elements[2]?.['content']).toBe('**Done** &#60;ok>')
    expect(elements[4]?.['content']).toBe('**bash&#95;&#42;**\n```json\n{\n  "command": "ls"\n}\n```')
    expect(elements[5]?.['content']).toContain('not json')
    expect(elements[6]?.['content']).toContain('Part 2/3')
    expect(JSON.stringify(assistantCard('zh', { text: 'x', part: { index: 1, total: 2 }, argumentLimit: 10 }))).toContain('第 1/2 部分')
    expect(assistantCard('en', { text: '', toolCalls: [{ name: 't', arguments: '{}' }], argumentLimit: 10 })).toMatchObject({ config: { summary: { content: 'Tool calls' } } })
    expect(assistantCard('en', { text: ' ', reasoning: ' ', toolCalls: [], argumentLimit: 10 })).toBeUndefined()
  })

  it('renders prompts from other clients and notices', () => {
    expect(elementsOf(userPromptCard('zh', 'hi <x>')).map(element => element['content'])).toEqual([
      "<font color='grey'>来自其他客户端的消息</font>", 'hi &#60;x>',
    ])
    expect(elementsOf(noticeCard('bad', 'error'))[0]?.['content']).toBe("<font color='red'>bad</font>")
    expect(elementsOf(noticeCard('ok'))[0]?.['content']).toBe('ok')
  })

  it('renders permission requests with buttons while pending and the decision afterwards', () => {
    const input = { toolName: 'bash', reason: 'needs `network`', arguments: '{"command":"curl x"}', argumentLimit: 100 }
    const pending = approvalCard('en', input, { kind: 'pending' })
    expect(pending['header']).toMatchObject({ title: { content: 'Permission request' }, subtitle: { content: 'bash' }, template: 'orange' })
    const buttons = elementsOf(pending).filter(element => element['tag'] === 'button')
    expect(buttons.map(button => button['behaviors'])).toEqual([
      [{ type: 'callback', value: { dsh: 'approval', decision: 'allow' } }],
      [{ type: 'callback', value: { dsh: 'approval', decision: 'reject' } }],
    ])
    expect(JSON.stringify(pending)).toContain('curl x')
    const allowed = approvalCard('zh', { toolName: 'bash', argumentLimit: 10 }, { kind: 'allowed', operator: OPERATOR })
    expect(allowed['header']).toMatchObject({ template: 'green' })
    expect(elementsOf(allowed).some(element => element['tag'] === 'button')).toBe(false)
    expect(JSON.stringify(allowed)).toContain('<at id=ou_alice></at>')
    expect(approvalCard('en', { toolName: 'bash', reason: ' ', argumentLimit: 10 }, { kind: 'rejected', operator: OPERATOR })['header']).toMatchObject({ template: 'grey' })
    expect(JSON.stringify(approvalCard('en', { toolName: 'bash', argumentLimit: 10 }, { kind: 'cancelled' }))).toContain('withdrew')
  })

  const QUESTIONS: AskUserQuestionItem[] = [
    { id: 'gpu', header: 'GPUs', question: 'How many GPUs?', detail: 'Pick one', options: [{ label: '8' }, { label: '16', description: 'two nodes' }] },
    { id: 'tags', question: 'Which tags?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
    { id: 'name', question: 'Run name?' },
  ]

  it('renders questions as one form and answers once given', () => {
    const pending = questionCard('en', QUESTIONS, { kind: 'pending' })
    const elements = elementsOf(pending)
    expect(elements.filter(element => typeof element['name'] === 'string').map(element => [element['tag'], element['name']])).toEqual([
      ['form', 'answer'],
      ['select_static', 'q0'], ['input', 'q0_text'],
      ['multi_select_static', 'q1'], ['input', 'q1_text'],
      ['input', 'q2_text'],
      ['button', 'submit'],
    ])
    expect(JSON.stringify(pending)).toContain('16 — two nodes')
    expect(JSON.stringify(questionCard('en', QUESTIONS, { kind: 'continued', error: true }))).toContain('Answer every question')
    expect(JSON.stringify(questionCard('en', QUESTIONS, { kind: 'continued' }))).toContain('stopped waiting')
    const answered = questionCard('zh', QUESTIONS, {
      kind: 'answered', operator: OPERATOR, answers: [{ id: 'gpu', selected: ['8'] }, { id: 'tags', selected: ['a'], custom: 'c' }],
    })
    expect(answered['header']).toMatchObject({ template: 'grey' })
    expect(JSON.stringify(answered)).toContain('> a · c')
    expect(JSON.stringify(questionCard('en', QUESTIONS, { kind: 'closed' }))).toContain('This question is closed.')
  })

  it('reads submitted forms into one answer per question', () => {
    expect(parseAnswers(QUESTIONS, { q0: 'o1', q1: ['o0', 'o1', 'o9'], q1_text: ' more ', q2_text: 'run-1' })).toEqual([
      { id: 'gpu', selected: ['16'] },
      { id: 'tags', selected: ['a', 'b'], custom: 'more' },
      { id: 'name', selected: [], custom: 'run-1' },
    ])
    expect(parseAnswers(QUESTIONS.slice(0, 1), { q0: 'o0', q0_text: 'twelve' })).toEqual([{ id: 'gpu', selected: [], custom: 'twelve' }])
    expect(parseAnswers(QUESTIONS, { q0: '', q1: ['o0'], q2_text: 'x' })).toBeUndefined()
    expect(parseAnswers(QUESTIONS.slice(2), { q2_text: '  ' })).toBeUndefined()
  })
})

describe('bridge commands', () => {
  it('recognizes only the bridge command names', () => {
    expect(parseBridgeCommand('/bind  session-1 ')).toEqual({ name: 'bind', argument: 'session-1 ' })
    expect(parseBridgeCommand('/status')).toEqual({ name: 'status', argument: '' })
    expect(parseBridgeCommand('/compact')).toBeUndefined()
    expect(parseBridgeCommand('/statusx')).toBeUndefined()
    expect(parseBridgeCommand('status')).toBeUndefined()
    for (const name of BRIDGE_COMMANDS) {
      expect(HELP.en).toContain(`/${name === 'help' ? 'status' : name}`)
    }
  })
})
