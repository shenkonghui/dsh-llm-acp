/// <reference types="node" />

/**
 * Unit tests for the DSH-addition marker matching behind the
 * `includeHarnessPrompt` / `includeRuntimeContext` settings switches. The
 * markers are the contract between dsh's prompt composition and this plugin's
 * stripping — if they drift, the toggles silently stop stripping.
 *
 * @module @deepseek-ai/dsh-llm-acp/tests/dsh-additions.spec
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDshAddition, SessionStore, sessionTitleFromMessages } from '../src/adapter.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function system(text: string): Message {
  return { role: 'system', content: [{ type: 'text', text }] }
}

describe('sessionTitleFromMessages', () => {
  it('extracts the first human message text as the title', () => {
    const title = sessionTitleFromMessages([user('Generate the session title from this JSON array of human messages:\n[{"seq":8,"text":"1 +1 =?"}]')])
    expect(title).toBe('1 +1 =?')
  })

  it('collapses whitespace and truncates long titles', () => {
    const long = 'a '.repeat(80).trim()
    const title = sessionTitleFromMessages([user(`Generate the session title from this JSON array of human messages:\n[{"seq":8,"text":"${long}"}]`)])
    expect(title).toBe(`${'a '.repeat(30).trim()}…`)
    expect(title?.length).toBe(60)
  })

  it('falls back to the model path (undefined) on a non-title prompt', () => {
    expect(sessionTitleFromMessages([user('10 + 10 =?')])).toBeUndefined()
  })

  it('falls back on malformed JSON in a title prompt', () => {
    expect(sessionTitleFromMessages([user('Generate the session title from this JSON array of human messages:\n[not json')])).toBeUndefined()
  })
})

describe('SessionStore', () => {
  it('persists entries across instances and drops malformed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-acp-store-'))
    const path = join(dir, 'sessions.json')
    const store = new SessionStore(path)
    store.set('s1', { acpSessionId: 'acp-1', messagesSent: 3 })
    // A second instance (a fresh harness run) reads the same file back.
    const reopened = new SessionStore(path)
    expect(reopened.get('s1')).toEqual({ acpSessionId: 'acp-1', messagesSent: 3 })
    reopened.delete('s1')
    expect(reopened.get('s1')).toBeUndefined()
    // A third instance sees the deletion — the file is the source of truth.
    expect(new SessionStore(path).get('s1')).toBeUndefined()
  })

  it('degrades to empty on a corrupt file and no-ops without a path', () => {
    const corruptPath = join(mkdtempSync(join(tmpdir(), 'dsh-store-')), 'sessions.json')
    writeFileSync(corruptPath, '{not json')
    const store = new SessionStore(corruptPath)
    expect(store.get('s1')).toBeUndefined()
    // A corrupt file is overwritten by the next successful write.
    store.set('s1', { acpSessionId: 'acp-1', messagesSent: 1 })
    expect(new SessionStore(corruptPath).get('s1')).toEqual({ acpSessionId: 'acp-1', messagesSent: 1 })
    // No path configured: every operation is a no-op.
    expect(new SessionStore(undefined).get('s1')).toBeUndefined()
  })
})

const harnessPreamble = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the glm-5-3-flash-high model.'
const runtimeContext = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write.'
const skillsReminder = '<system-reminder>\nA skill is a reusable set of task-specific instructions.'
const realQuestion = '10 + 10 =?'

describe('isDshAddition', () => {
  it('strips all DSH additions when both switches are off (default)', () => {
    for (const text of [harnessPreamble, runtimeContext, skillsReminder]) {
      expect(isDshAddition({ role: 'user', content: [{ type: 'text', text }] }, false, false)).toBe(true)
      expect(isDshAddition({ role: 'system', content: [{ type: 'text', text }] }, false, false)).toBe(true)
    }
  })

  it('keeps real user messages regardless of the switches', () => {
    expect(isDshAddition({ role: 'user', content: [{ type: 'text', text: realQuestion }] }, false, false)).toBe(false)
  })

  it('keeps assistant messages even when they quote a marker', () => {
    expect(isDshAddition({ role: 'assistant', content: [{ type: 'text', text: runtimeContext }] }, false, false)).toBe(false)
  })

  it('keeps the harness preamble when includeHarnessPrompt is on', () => {
    expect(isDshAddition({ role: 'user', content: [{ type: 'text', text: harnessPreamble }] }, true, false)).toBe(false)
  })

  it('keeps runtime context and the skills catalog when includeRuntimeContext is on', () => {
    expect(isDshAddition({ role: 'user', content: [{ type: 'text', text: runtimeContext }] }, false, true)).toBe(false)
    expect(isDshAddition({ role: 'user', content: [{ type: 'text', text: skillsReminder }] }, true, true)).toBe(false)
  })
})
