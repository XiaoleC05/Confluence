// WP5 — Confluence model-facing tools: contract, rendering, errors, universal memory scope.
//
// Hermetic: a fake facade in this file, no DSH runtime, no filesystem, no network. The facade
// shape follows the v0.2.0 contract (index.js provides it; ADR-0007): memory is universal, so
// `facade.workspaceFor()` always resolves to `{ key:'global', label:'All sessions' }`. The tests
// also pin the exact tool-api.md render shapes and the `through=<ULID>` watermark marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools, registerTools } from '../lib/tools.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT = Object.freeze({ id: 'session-a', session: { header: { cwd: 'D:\\ws' } } });
const CONFIG = Object.freeze({
  store: { maxBodyBytes: 8192 },
  recall: { enabled: true, timeoutMs: 5000 },
});

const ULID = '01J8Z6Q3M5';

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function defaultBoardView() {
  return {
    entries: [
      { id: 'cnf_m2', seq: '01M2', kind: 'gotcha', title: 'Windows rename retries wrap in EPERM', author: { title: 'Auth work' } },
      { id: 'cnf_m1', seq: '01M1', kind: 'decision', title: 'Pin deps to 0.2.x', author: { title: 'Data migration' } },
    ],
    openQuestions: [
      { id: 'cnf_q1', seq: '01Q1', kind: 'question', title: 'Which index rebuild strategy?', author: { title: 'Schema migration' }, resolved: false },
    ],
    openHandoffs: [
      { id: 'cnf_h1', seq: '01H1', kind: 'handoff', title: 'Continue the panel after the transport spike', author: { title: 'Panel work' }, resolved: false },
    ],
    stats: { entries: 12, unread: 2, maxSeq: ULID },
    peers: [{ title: 'schema-migration' }, { title: 'auth-api' }],
    recent: [],
  };
}

function defaultReadEntry(ref) {
  if (ref.startsWith('session:')) {
    const [, sessionId, seq] = ref.split(':');
    return {
      sessionRef: ref,
      sessionId,
      title: 'Auth work',
      events: [{ seq: Number(seq), role: 'assistant/message', text: 'root cause: the fixture runs before TZ is set; export TZ=UTC.' }],
      truncated: false,
    };
  }
  return {
    entry: {
      id: ref,
      seq: '01M1',
      kind: 'decision',
      title: 'Pin deps to 0.2.x',
      body: 'Pin all @deepseek-ai/* packages to the installed 0.2.x line; mismatched minors break the projection cache.',
      author: { title: 'Data migration' },
    },
    replies: [
      { id: 'cnf_r1', seq: '01R1', kind: 'finding', title: 'Pinned in package.json', author: { title: 'Data migration' } },
    ],
    omitted: 1240,
  };
}

function defaultSearchResult() {
  return {
    hits: [
      { entry: { id: 'cnf_m1', seq: '01M1', kind: 'decision', title: 'Pin deps to 0.2.x', author: { title: 'Data migration' } } },
      { entry: { id: 'cnf_q1', seq: '01Q1', kind: 'question', title: 'Which index rebuild strategy?', author: { title: 'Schema migration' } } },
    ],
    truncated: true,
    total: 4,
  };
}

function defaultRecallResult() {
  return {
    hits: [
      { sessionId: 'session-a1', seq: 412, excerpt: 'root cause: the fixture runs before TZ is set; export TZ=UTC.', ref: 'session:session-a1:412', type: 'assistant/message' },
      { sessionId: 'session-b2', seq: 88, excerpt: 'decided to pin the dependency line after the EPERM retry fix.', ref: 'session:session-b2:88', type: 'tool/result' },
    ],
    truncated: false,
    sessionsSearched: 2,
    sessionsMatched: 2,
    eligibleSessions: 3,
    timedOut: false,
    tookMs: 12,
  };
}

function makeFacade(overrides = {}) {
  const calls = [];
  const defaults = {
    workspaceFor: () => ({ key: 'global', label: 'All sessions' }),
    boardView: () => defaultBoardView(),
    post: (_agent, input) => ({ id: 'cnf_post1', seq: '01POSTSEQ', kind: input.kind, status: 'published' }),
    readEntry: (_agent, ref) => defaultReadEntry(ref),
    search: () => defaultSearchResult(),
    reply: (_agent, input) => ({ id: 'cnf_reply1', seq: '01REPLYSEQ', resolved: Boolean(input.resolves) }),
    recall: () => defaultRecallResult(),
  };
  const facade = {};
  for (const name of Object.keys(defaults)) {
    facade[name] = (...args) => {
      calls.push({ name, args });
      const override = overrides[name];
      if (override !== undefined) {
        return typeof override === 'function' ? override(...args) : override;
      }
      return defaults[name](...args);
    };
  }
  return { facade, calls };
}

function setup(overrides = {}, config = CONFIG) {
  const { facade, calls } = makeFacade(overrides);
  const definitions = createTools(facade, config);
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return { facade, calls, definitions, byName };
}

async function run(byName, name, args, { agent = AGENT, execExtra = {} } = {}) {
  const definition = byName.get(name);
  assert.ok(definition, `missing tool ${name}`);
  return definition.execute(args, { agent, callId: 'call-1', signal: new AbortController().signal, ...execExtra });
}

function rendered(definition, args, value) {
  const blocks = definition.output.render(args, value);
  assert.ok(Array.isArray(blocks), 'render must return an array of content blocks');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
  assert.ok(blocks[0].text.length > 0, 'rendered text must not be empty');
  return blocks[0].text;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, new RegExp(`^${code}:`), 'error message begins with the stable code');
    return true;
  });
}

// ---------------------------------------------------------------------------
// CON-TOOL-01..06 — definition contract and token budget
// ---------------------------------------------------------------------------

test('UT-TOOL-01 six tool definitions match the model-facing contract', () => {
  const { definitions } = setup();
  const names = definitions.map((definition) => definition.name);
  assert.deepEqual(names, ['confluence_board', 'confluence_post', 'confluence_read', 'confluence_search', 'confluence_reply', 'confluence_recall']);
  assert.equal(new Set(names).size, 6);

  const requiredDescriptions = {
    confluence_board: /untrusted/i,
    confluence_post: /append-only/i,
    confluence_read: /untrusted/i,
    confluence_search: /board notes only/i,
    confluence_reply: /confluence_post/i,
    confluence_recall: /literal/i,
  };
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length >= 80, `${definition.name} description is too short`);
    assert.match(definition.description, requiredDescriptions[definition.name]);
    // Static (config-independent) descriptions: no interpolated numbers from config.
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.parameters.properties, 'object');
    assert.ok(Array.isArray(definition.parameters.required));
    for (const [name, schema] of Object.entries(definition.parameters.properties)) {
      assert.ok(['string', 'integer', 'boolean', 'array'].includes(schema.type), `${definition.name}.${name} has a supported type`);
      assert.equal(typeof schema.description, 'string', `${definition.name}.${name} carries a description`);
    }
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.output.schema.additionalProperties, false);
    assert.ok(Array.isArray(definition.output.schema.required));
    assert.equal(typeof definition.output.render, 'function');
    for (const field of definition.output.schema.required) {
      assert.ok(field in definition.output.schema.properties, `${definition.name} output requires declared field ${field}`);
    }
  }
});

test('UT-TOOL-02 schema+description token budget stays inside the target', (t) => {
  const { definitions } = setup();
  const chars = definitions.reduce(
    (sum, definition) => sum + JSON.stringify({ description: definition.description, parameters: definition.parameters }).length,
    0,
  );
  const estimatedTokens = Math.ceil(chars / 4);
  t.diagnostic(`tools schema+descriptions: ${chars} chars ≈ ${estimatedTokens} tokens (target 900-1200, hard <1200)`);
  assert.ok(chars < 1200 * 4, `tool schema budget exceeded: ${chars} chars`);
});

test('UT-TOOL-03 module is dependency-free and documents PTC reachability', () => {
  const source = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"](?:node:|@deepseek-ai)/, 'no node:/@deepseek-ai imports');
  assert.doesNotMatch(source, /\brequire\s*\(/, 'no CommonJS require');
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'no fetch');
  assert.doesNotMatch(source, /child_process|\bnet\b|https?:/, 'no network/child-process references');
  assert.match(source, /run_code/, 'PTC reachability note is present');
});

// ---------------------------------------------------------------------------
// confluence_board
// ---------------------------------------------------------------------------

test('UT-TOOL-04 board renders unread notes, open items, peers and the through marker', async () => {
  const { byName, calls } = setup();
  const value = await run(byName, 'confluence_board', { limit: 2 });
  assert.deepEqual(calls[0], { name: 'workspaceFor', args: [AGENT] });
  assert.deepEqual(calls[1], { name: 'boardView', args: [AGENT] });
  assert.equal(value.workspace, 'All sessions');
  assert.equal(value.unread, 2);
  assert.equal(value.notes_total, 12);
  assert.equal(value.peers, 2);
  assert.equal(value.open_questions, 1);
  assert.equal(value.open_handoffs, 1);
  assert.equal(value.through, ULID);
  assert.equal(value.omitted, 10);
  assert.deepEqual(value.notes.map((note) => note.id), ['cnf_m2', 'cnf_m1']);
  assert.equal(value.open[0].id, 'cnf_q1');

  const text = rendered(byName.get('confluence_board'), { limit: 2 }, value);
  assert.match(text, /^<confluence-result trust="untrusted">/);
  assert.match(text, /Untrusted data written by other sessions/);
  assert.match(text, /<confluence-board name="All sessions" unread="2" notes="12" open="1 question, 1 handoff" peers="2">/);
  assert.match(text, /\[cnf_m2\] gotcha "Windows rename retries wrap in EPERM" by "Auth work"/);
  assert.match(text, /Open: \[cnf_q1\] question "Which index rebuild strategy\?" by "Schema migration"/);
  assert.match(text, /Here now: "schema-migration", "auth-api"/);
  assert.match(text, /\(10 older notes omitted; raise limit or use confluence_search\)/);
  assert.match(text, /^through=01J8Z6Q3M5$/m);
  assert.ok(text.trimEnd().endsWith('</confluence-board>\n</confluence-result>'));
});

test('UT-TOOL-05 board limit, include_resolved and empty-board shapes', async () => {
  const { byName } = setup();
  const view = defaultBoardView();
  view.entries = view.entries.slice(0, 1);
  const limited = await run(byName, 'confluence_board', { limit: 1 });
  assert.equal(limited.notes.length, 1);
  assert.equal(limited.omitted, 11);

  const resolved = defaultBoardView();
  resolved.openHandoffs[0].resolved = true;
  const withResolved = setup({ boardView: () => resolved });
  const value = await run(withResolved.byName, 'confluence_board', { include_resolved: true });
  assert.equal(value.open_handoffs, 1);
  assert.equal(value.open.find((item) => item.id === 'cnf_h1').resolved, true);
  const text = rendered(withResolved.byName.get('confluence_board'), { include_resolved: true }, value);
  assert.match(text, /\[cnf_h1\] handoff .* \(resolved\)/);

  const empty = setup({
    boardView: () => ({ entries: [], openQuestions: [], openHandoffs: [], stats: { entries: 0, unread: 0, maxSeq: '' }, peers: [], recent: [] }),
  });
  const emptyValue = await run(empty.byName, 'confluence_board', {});
  const emptyText = rendered(empty.byName.get('confluence_board'), {}, emptyValue);
  assert.equal(emptyText, 'Shared memory across sessions is empty. Publish with confluence_post.\nthrough=');
});

test('UT-TOOL-06 board argument validation and universal-scope degradation', async () => {
  const { byName } = setup();
  await rejectsWith(run(byName, 'confluence_board', { limit: 0 }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_board', { limit: 11 }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_board', { limit: 2.5 }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_board', { include_resolved: 'yes' }), 'INVALID_ARGUMENT');

  // Scope wording is display-only: a null/failed/absent resolver never blocks shared memory.
  const nullScope = setup({ workspaceFor: () => null });
  assert.equal((await run(nullScope.byName, 'confluence_board', {})).workspace, 'All sessions');
  const throwingScope = setup({
    workspaceFor: () => {
      throw new Error('scope resolver is unavailable');
    },
  });
  assert.equal((await run(throwingScope.byName, 'confluence_board', {})).workspace, 'All sessions');
});

// ---------------------------------------------------------------------------
// confluence_post
// ---------------------------------------------------------------------------

test('UT-TOOL-07 post publishes with mapping/redaction markers and duplicate handling', async () => {
  const { byName, calls } = setup();
  const value = await run(byName, 'confluence_post', {
    kind: 'gotcha',
    title: 'Windows rename retries wrap in EPERM',
    body: 'The wrapper only retried EBUSY; see lib/journal.js.',
    tags: ['windows'],
    files: ['lib/journal.js'],
    reply_to: 'cnf_q1',
    resolves: true,
    supersedes: 'cnf_m1',
  });
  assert.deepEqual(value, { id: 'cnf_post1', kind: 'gotcha', seq: '01POSTSEQ', duplicate: false });
  const postCall = calls.find((call) => call.name === 'post');
  assert.deepEqual(postCall.args[1], {
    kind: 'gotcha',
    title: 'Windows rename retries wrap in EPERM',
    body: 'The wrapper only retried EBUSY; see lib/journal.js.',
    tags: ['windows'],
    files: ['lib/journal.js'],
    replyTo: 'cnf_q1',
    resolves: true,
    supersedes: 'cnf_m1',
  });
  const text = rendered(byName.get('confluence_post'), {}, value);
  assert.match(text, /^Published cnf_post1 \[gotcha\] in shared memory \(seq 01POSTSEQ\)\./m);
  assert.match(text, /Other sessions see it in their next pulse; replies use confluence_reply\./);

  const duplicate = setup({ post: () => ({ id: 'cnf_dup', seq: '01DUP', kind: 'decision', status: 'duplicate' }) });
  const duplicateValue = await run(duplicate.byName, 'confluence_post', { kind: 'decision', title: 'x' });
  assert.equal(duplicateValue.duplicate, true);
  const duplicateText = rendered(duplicate.byName.get('confluence_post'), {}, duplicateValue);
  assert.equal(duplicateText, 'Already published as cnf_dup in this turn; no second note was written.');
});

test('UT-TOOL-08 post rejects invalid content before touching the facade', async () => {
  const { byName, calls } = setup();
  await rejectsWith(run(byName, 'confluence_post', { kind: 'note', title: 'x' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_post', { kind: 'decision', title: '   ' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_post', { kind: 'decision', title: 't'.repeat(161) }), 'LIMIT_EXCEEDED');
  await rejectsWith(run(byName, 'confluence_post', { kind: 'decision', title: 'x', body: 'b'.repeat(8193) }), 'BODY_TOO_LARGE');
  await rejectsWith(run(byName, 'confluence_post', { kind: 'decision', title: 'x', tags: new Array(9).fill('t') }), 'LIMIT_EXCEEDED');
  await rejectsWith(run(byName, 'confluence_post', { kind: 'decision', title: 'x', resolves: true }), 'INVALID_ARGUMENT');
  assert.equal(calls.filter((call) => call.name === 'post').length, 0, 'no facade write on validation failure');
});

// ---------------------------------------------------------------------------
// confluence_read
// ---------------------------------------------------------------------------

test('UT-TOOL-09 read board entry renders thread and advances through', async () => {
  const { byName } = setup();
  const value = await run(byName, 'confluence_read', { ref: 'cnf_m1' });
  assert.equal(value.source, 'board');
  assert.equal(value.ref, 'cnf_m1');
  assert.equal(value.title, 'Pin deps to 0.2.x');
  assert.equal(value.through, '01R1');
  assert.equal(value.replies.length, 1);
  const text = rendered(byName.get('confluence_read'), { ref: 'cnf_m1' }, value);
  assert.match(text, /<confluence-board name="All sessions">/);
  assert.match(text, /\[cnf_m1\] decision "Pin deps to 0\.2\.x" by "Data migration"/);
  assert.match(text, /Body: Pin all @deepseek-ai\/\* packages/);
  assert.match(text, /Replies \(1\):/);
  assert.match(text, /\(truncated: \+1240 chars\)/);
  assert.match(text, /^through=01R1$/m);
  assert.ok(text.trimEnd().endsWith('</confluence-board>\n</confluence-result>'));
});

test('UT-TOOL-10 read session ref renders bounded excerpt and advances nothing', async () => {
  const { byName } = setup();
  const value = await run(byName, 'confluence_read', { ref: 'session:session-af98aac6:412' });
  assert.equal(value.source, 'session');
  assert.equal(value.through, '');
  assert.equal(value.session_id, 'session-af98aac6');
  const text = rendered(byName.get('confluence_read'), { ref: 'session:session-af98aac6:412' }, value);
  assert.match(text, /<confluence-session title="Auth work">/);
  assert.match(text, /\[session-af98aac6 #412 assistant\/message\]/);
  assert.match(text, /literal excerpt; partial \(1 event shown\)/);
  assert.doesNotMatch(text, /^through=/m, 'session reads never emit a board marker');
  assert.ok(text.trimEnd().endsWith('</confluence-session>\n</confluence-result>'));
});

test('UT-TOOL-11 read validates refs and propagates facade NOT_FOUND', async () => {
  const { byName } = setup();
  await rejectsWith(run(byName, 'confluence_read', { ref: '   ' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_read', { ref: 'http://example.com/x' }), 'INVALID_REF');
  await rejectsWith(run(byName, 'confluence_read', { ref: 'session:only-two' }), 'INVALID_REF');
  const missing = setup({ readEntry: () => ({ notFound: true }) });
  await rejectsWith(run(missing.byName, 'confluence_read', { ref: 'cnf_missing' }), 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// confluence_search
// ---------------------------------------------------------------------------

test('UT-TOOL-12 search renders matches, truncation hint and the empty result', async () => {
  const { byName, calls } = setup();
  const value = await run(byName, 'confluence_search', { query: 'dependency pin', kind: 'decision', limit: 5 });
  assert.equal(value.hits.length, 2);
  assert.equal(value.total, 4);
  assert.equal(value.truncated, true);
  const searchCall = calls.find((call) => call.name === 'search');
  assert.deepEqual(searchCall.args[1], { query: 'dependency pin', kind: 'decision', tag: undefined, limit: 5 });
  const text = rendered(byName.get('confluence_search'), { query: 'dependency pin', kind: 'decision' }, value);
  assert.match(text, /\[cnf_m1\] decision "Pin deps to 0\.2\.x" by "Data migration" — matches: kind/);
  assert.match(text, /\(2 more matches; narrow with kind or tag, or raise limit\)/);
  assert.match(text, /^<confluence-result trust="untrusted">/);

  const empty = setup({ search: () => ({ hits: [], truncated: false, total: 0 }) });
  const emptyValue = await run(empty.byName, 'confluence_search', { query: 'zzz' });
  const emptyText = rendered(empty.byName.get('confluence_search'), { query: 'zzz' }, emptyValue);
  assert.equal(emptyText, 'No board notes match "zzz".');
});

test('UT-TOOL-13 search argument validation', async () => {
  const { byName } = setup();
  await rejectsWith(run(byName, 'confluence_search', {}), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_search', { query: 'x'.repeat(201) }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_search', { query: 'x', kind: 'rumor' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_search', { query: 'x', limit: 0 }), 'INVALID_ARGUMENT');
});

// ---------------------------------------------------------------------------
// confluence_reply
// ---------------------------------------------------------------------------

test('UT-TOOL-14 reply renders plain answers, resolves and reopens', async () => {
  const { byName, calls } = setup();
  const plain = await run(byName, 'confluence_reply', { id: 'cnf_q1', body: 'Use the refresh-on-write path.' });
  assert.deepEqual(plain, { id: 'cnf_reply1', thread_id: 'cnf_q1', seq: '01REPLYSEQ', resolved: false });
  const replyCall = calls.find((call) => call.name === 'reply');
  assert.deepEqual(replyCall.args[1], { id: 'cnf_q1', body: 'Use the refresh-on-write path.', resolves: undefined });
  assert.match(rendered(byName.get('confluence_reply'), {}, plain), /^Replied cnf_reply1 on thread cnf_q1 \(seq 01REPLYSEQ\)\./m);

  const resolved = setup({ reply: () => ({ id: 'cnf_reply2', seq: '01REPLY2', resolved: true, threadId: 'cnf_q1' }) });
  const resolvedValue = await run(resolved.byName, 'confluence_reply', { id: 'cnf_q1', resolves: true });
  assert.equal(resolvedValue.resolved, true);
  assert.equal(resolvedValue.thread_id, 'cnf_q1');
  assert.match(rendered(resolved.byName.get('confluence_reply'), {}, resolvedValue), /marked the question resolved/);

  const reopened = setup({ reply: () => ({ id: 'cnf_reply3', seq: '01REPLY3', resolved: false, threadId: 'cnf_q1' }) });
  const reopenedValue = await run(reopened.byName, 'confluence_reply', { id: 'cnf_q1', resolves: false });
  assert.match(rendered(reopened.byName.get('confluence_reply'), {}, reopenedValue), /reopened the question/);
});

test('UT-TOOL-15 reply validation and facade error propagation', async () => {
  const { byName } = setup();
  await rejectsWith(run(byName, 'confluence_reply', { id: 'cnf_q1' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_reply', { id: '   ', body: 'x' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_reply', { id: 'cnf_q1', body: 'b'.repeat(8193) }), 'BODY_TOO_LARGE');
  const invalidResolve = setup({
    reply: () => {
      throw codedError('INVALID_ARGUMENT', 'only questions and handoffs can be resolved.');
    },
  });
  await rejectsWith(run(invalidResolve.byName, 'confluence_reply', { id: 'cnf_m1', resolves: true }), 'INVALID_ARGUMENT');
});

// ---------------------------------------------------------------------------
// confluence_recall
// ---------------------------------------------------------------------------

test('UT-TOOL-16 recall renders bounded literal hits with provenance refs', async () => {
  const { byName, calls } = setup();
  const value = await run(byName, 'confluence_recall', { query: 'TZ=UTC' });
  assert.equal(value.hits.length, 2);
  assert.equal(value.sessions_searched, 2);
  assert.equal(value.eligible_sessions, 3);
  assert.equal(value.sessions_matched, 2);
  assert.equal(value.partial, false);
  assert.equal(value.timed_out, false);
  assert.equal(value.timeout_ms, 5000);
  const recallCall = calls.find((call) => call.name === 'recall');
  assert.deepEqual(recallCall.args[1], { query: 'TZ=UTC', limit: 5 });
  const text = rendered(byName.get('confluence_recall'), { query: 'TZ=UTC' }, value);
  assert.match(text, /^<confluence-result trust="untrusted">/);
  assert.match(text, /Searched 2 of 3 eligible sessions; literal match only; partial coverage/);
  assert.match(text, /\[session:session-a1:412 assistant\/message\] "root cause: the fixture runs before TZ is set; export TZ=UTC\."/);
  assert.match(text, /Open with confluence_read \{"ref":"session:session-a1:412"\}\./);
  assert.match(text, /^<\/confluence-result>$/m);
});

test('UT-TOOL-17 recall partial/timeout/empty/config-disabled paths', async () => {
  const partial = setup({
    recall: () => ({ hits: [{ sessionId: 's1', seq: 1, excerpt: 'partial hit' }], truncated: true, timedOut: true, tookMs: 5001, sessionsSearched: 1 }),
  });
  const partialValue = await run(partial.byName, 'confluence_recall', { query: 'deploy' });
  assert.equal(partialValue.partial, true);
  assert.equal(partialValue.timed_out, true);
  assert.match(rendered(partial.byName.get('confluence_recall'), { query: 'deploy' }, partialValue), /\(partial: timed out after 5000 ms\)/);

  const timedOutEmpty = setup({ recall: () => ({ hits: [], truncated: true, timedOut: true, tookMs: 5001 }) });
  await rejectsWith(run(timedOutEmpty.byName, 'confluence_recall', { query: 'deploy' }), 'RECALL_TIMEOUT');

  const empty = setup({ recall: () => ({ hits: [], truncated: false, sessionsSearched: 0, eligibleSessions: 1 }) });
  const emptyValue = await run(empty.byName, 'confluence_recall', { query: 'nothing' });
  assert.equal(rendered(empty.byName.get('confluence_recall'), { query: 'nothing' }, emptyValue), 'No literal matches in earlier sessions on this machine.');

  const disabled = setup({}, { store: { maxBodyBytes: 8192 }, recall: { enabled: false } });
  await rejectsWith(run(disabled.byName, 'confluence_recall', { query: 'x y' }), 'RECALL_UNAVAILABLE');
});

test('UT-TOOL-18 recall argument validation', async () => {
  const { byName } = setup();
  await rejectsWith(run(byName, 'confluence_recall', { query: 'x' }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_recall', { query: 'x'.repeat(201) }), 'INVALID_ARGUMENT');
  await rejectsWith(run(byName, 'confluence_recall', { query: 'ok words', limit: 11 }), 'INVALID_ARGUMENT');
});

// ---------------------------------------------------------------------------
// Universal memory scope, error mapping and registration (ADR-0007 §2.4 / tool-api §1.2)
// ---------------------------------------------------------------------------

test('UT-TOOL-19 shared memory is universal: no NO_WORKSPACE path and no argument-supplied scope', async () => {
  const calls = [
    ['confluence_board', {}],
    ['confluence_post', { kind: 'decision', title: 'x' }],
    ['confluence_read', { ref: 'cnf_m1' }],
    ['confluence_search', { query: 'x' }],
    ['confluence_reply', { id: 'cnf_q1', body: 'x' }],
    ['confluence_recall', { query: 'x y' }],
  ];

  // The facade alias always resolves the global scope, so every tool works with no workspace.
  const globalScope = setup({ workspaceFor: () => ({ key: 'global', label: 'All sessions' }) });
  for (const [name, args] of calls) {
    const value = await run(globalScope.byName, name, args);
    assert.ok(value && typeof value === 'object', `${name} must succeed without a workspace`);
  }
  // Scope/user identity comes from exec.agent only; no tool accepts a workspace/session argument.
  for (const definition of globalScope.definitions) {
    const fields = Object.keys(definition.parameters.properties);
    assert.equal(fields.includes('workspace'), false, `${definition.name} must not accept a workspace argument`);
    assert.equal(fields.includes('scope'), false, `${definition.name} must not accept a scope argument`);
    assert.equal(fields.includes('session_id'), false, `${definition.name} must not accept a session argument`);
  }
  const scopedCalls = globalScope.calls.filter((call) => call.name === 'workspaceFor');
  assert.ok(scopedCalls.length > 0, 'the board/read paths ask the facade for the display label');
  for (const call of scopedCalls) assert.deepEqual(call.args, [AGENT]);

  // A facade without the retained alias still serves memory (label degrades to "All sessions").
  const { facade } = makeFacade();
  delete facade.workspaceFor;
  const aliasFree = createTools(facade, CONFIG);
  const aliasFreeByName = new Map(aliasFree.map((definition) => [definition.name, definition]));
  assert.equal((await run(aliasFreeByName, 'confluence_board', {})).workspace, 'All sessions');
  for (const [name, args] of calls.filter(([name]) => name !== 'confluence_board')) {
    const value = await run(aliasFreeByName, name, args);
    assert.ok(value && typeof value === 'object', `${name} must not depend on workspaceFor()`);
  }

  // Without a session identity there is no caller to attribute memory to: UNAVAILABLE, never
  // NO_WORKSPACE (universal memory has no workspace requirement to satisfy).
  const { byName } = setup();
  for (const [name, args] of calls) {
    await rejectsWith(run(byName, name, args, { agent: null }), 'UNAVAILABLE');
  }
});

test('UT-TOOL-21 tool wording is universal (no workspace-scoped memory language)', () => {
  const { definitions } = setup();
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  for (const definition of definitions) {
    const surface = JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output.schema,
    });
    assert.doesNotMatch(surface, /this workspace|workspace's shared board|workspace-relative|workspace board/i);
    assert.doesNotMatch(surface, /NO_WORKSPACE/);
  }
  assert.match(byName.get('confluence_board').description, /shared memory across sessions/i);
  assert.match(byName.get('confluence_post').description, /shared memory across sessions/i);
  assert.match(byName.get('confluence_search').description, /shared memory across sessions/i);
  assert.match(byName.get('confluence_recall').description, /all earlier sessions on this machine/i);
});

test('UT-TOOL-20 unknown facade failures become STORE_UNAVAILABLE with a short cause', async () => {
  const broken = setup({
    boardView: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  await rejectsWith(run(broken.byName, 'confluence_board', {}), 'STORE_UNAVAILABLE');
  const text = (await run(broken.byName, 'confluence_board', {}).catch((error) => error)).message;
  assert.match(text, /^STORE_UNAVAILABLE: board read\/wrote failed \(EACCES: permission denied\)\.$/);
});

test('CON-TOOL-06 registerTools registers all six globally and returns one disposer', () => {
  const { definitions } = setup();
  const registered = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        const dispose = () => disposers.push(definition.name);
        return dispose;
      },
    },
  };
  const dispose = registerTools(ctx, definitions);
  assert.equal(registered.length, 6);
  assert.deepEqual(registered.map((definition) => definition.name), definitions.map((definition) => definition.name));
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.deepEqual(disposers, definitions.map((definition) => definition.name).reverse());

  assert.throws(() => registerTools({}, definitions), TypeError);
  assert.throws(() => registerTools({ tools: { register() {} } }, 'nope'), TypeError);
  assert.throws(() => createTools(null, {}), TypeError);
});

test('CON-TOOL-06b every documented example renders deterministic text blocks', async () => {
  const { byName } = setup();
  const examples = [
    ['confluence_board', { limit: 4 }],
    ['confluence_post', { kind: 'question', title: 'Who owns the migration fixture?', body: 'Blocking the schema work.' }],
    ['confluence_read', { ref: 'cnf_m1' }],
    ['confluence_search', { query: 'index' }],
    ['confluence_reply', { id: 'cnf_q1', body: 'Use the refresh-on-write path.' }],
    ['confluence_recall', { query: 'TZ=UTC' }],
  ];
  for (const [name, args] of examples) {
    const definition = byName.get(name);
    const value = await run(byName, name, args);
    const first = rendered(definition, args, value);
    const second = rendered(definition, args, value);
    assert.equal(first, second, `${name} render must be deterministic`);
    // Untrusted-content results are wrapped; the two write confirmations are not.
    if (['confluence_board', 'confluence_read', 'confluence_search', 'confluence_recall'].includes(name)) {
      assert.match(first, /^<confluence-result trust="untrusted">/);
    } else {
      assert.doesNotMatch(first, /confluence-result/);
    }
  }
});
