import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate, validateInspection } from '../src/extension.js';
import { cliCommand, runPatina } from '../src/cli.js';

const checksum = (text) => createHash('sha256').update(text).digest('hex');
function host({ choice = 'Discard', trusted = true, invoke, language = 'en', initialText = 'Before text.', backend = 'auto' } = {}) {
  let text = initialText; const commands = new Map(); const errors = []; const events = []; const notices = []; const items = new Map();
  const uri = { scheme: 'file', fsPath: '/tmp/patina-document.md', toString: () => 'file:///tmp/patina-document.md' };
  const document = { uri, version: 1, isClosed: false, getText: (range) => range ? text.slice(range.start, range.end) : text, positionAt: (offset) => offset };
  const editor = { document, selection: { start: 0, end: text.length }, async edit(callback) { callback({ replace(_range, value) { text = value; document.version++; } }); return true; } };
  const dispose = () => ({ dispose() {} });
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, DiagnosticSeverity: { Warning: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } }, Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    Uri: { parse: (value) => ({ toString: () => value }) },
    languages: { createDiagnosticCollection: () => ({ set(key, value) { items.set(key.toString(), value); }, delete(key) { items.delete(key.toString()); }, dispose() {} }) },
    workspace: { isTrusted: trusted, getConfiguration: () => ({ get: (key, fallback) => ({ language, backend, autoScore: false }[key] ?? fallback) }),
      getWorkspaceFolder: () => null, registerTextDocumentContentProvider: dispose, onDidChangeTextDocument: dispose, onDidCloseTextDocument: dispose,
      async openTextDocument(value) { return value; } },
    window: { activeTextEditor: editor, createStatusBarItem: () => ({ show() {}, dispose() {} }), onDidChangeActiveTextEditor: dispose,
      showErrorMessage: (message) => errors.push(message), async showInformationMessage(message) { notices.push(message); events.push('confirmation'); return typeof choice === 'function' ? choice(document) : choice; },
      async showTextDocument(doc) { return doc === document ? editor : { document: doc }; },
      withProgress: async (_options, callback) => callback({}, { isCancellationRequested: false, onCancellationRequested: dispose }) },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return dispose(); }, async executeCommand(name) { events.push(name); } },
  };
  const context = { subscriptions: [] };
  const api = activate(context, vscode, { invoke: invoke || (async () => ({ output: 'After text.' })) });
  return { document, editor, vscode, commands, errors, events, notices, items, api,
    value: () => text, mutate(value) { text = value; document.version++; }, dispose() { for (const item of context.subscriptions) item.dispose(); } };
}

test('rewrite is verified and cannot apply before the diff confirmation', async () => {
  let request; const h = host({ choice: 'Discard', invoke: async (value) => { request = value; return { output: 'After text.' }; } });
  await h.commands.get('patina.humanizeSelection')();
  assert.equal(h.value(), 'Before text.'); assert.ok(request.args.includes('--verify'));
  assert.equal(request.text, 'Before text.'); assert.ok(!request.args.includes(request.text));
  assert.deepEqual(h.events, ['vscode.diff', 'confirmation']); h.dispose();
});

test('confirmed rewrite applies only to the unchanged document', async () => {
  const h = host({ choice: 'Apply' }); await h.commands.get('patina.humanizeSelection')();
  assert.equal(h.value(), 'After text.'); h.dispose();
  let changed; changed = host({ choice: 'Apply', invoke: async () => { changed.mutate('User edit.'); return { output: 'After text.' }; } });
  await changed.commands.get('patina.humanizeSelection')();
  assert.equal(changed.value(), 'User edit.'); assert.ok(changed.errors.some((message) => message.includes('changed'))); changed.dispose();
  let closed; closed = host({ choice: () => { closed.document.isClosed = true; return 'Apply'; } });
  await closed.commands.get('patina.humanizeSelection')(); assert.equal(closed.value(), 'Before text.'); closed.dispose();
});

test('untrusted workspaces cannot invoke the CLI', async () => {
  const h = host({ trusted: false, invoke: () => assert.fail('untrusted invocation') });
  await h.commands.get('patina.humanizeSelection')(); assert.ok(h.errors.length); h.dispose();
});

test('inspection checks schema, source binding and diagnostic ranges', () => {
  const text = 'Sample'; const value = { schemaVersion: 1, deterministicOnly: true, sourceHash: checksum(text), language: 'en', available: true, score: 20, diagnostics: [] };
  assert.equal(validateInspection(value, text), value);
  assert.throws(() => validateInspection({ ...value, sourceHash: 'wrong' }, text));
  assert.throws(() => validateInspection({ ...value, diagnostics: [{ start: 0, end: 99, message: 'bad' }] }, text));
});

test('CLI bridge transports literal Unicode through stdin, not shell arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patina-editor-cli-test-'));
  try {
    const path = join(dir, 'fake.mjs');
    writeFileSync(path, 'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>console.log(JSON.stringify({text,args:process.argv.slice(2)})));');
    const text = '한국어 $(do-not-run) `literal` "quoted"';
    const value = await runPatina({ cliPath: path, args: ['inspect', '--lang', 'ko'], text, cwd: dir, timeoutMs: 3000 });
    assert.equal(value.text, text); assert.deepEqual(value.args, ['inspect', '--lang', 'ko']);
    assert.throws(() => cliCommand('bad\ncommand'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('npm resolution is offline except for an explicit installation action', async () => {
  assert.ok(cliCommand().args.includes('--offline'));
  assert.ok(!cliCommand(undefined, { online: true }).args.includes('--offline'));
  let request; const h = host({ invoke: async (value) => { request = value; return 'patina 8.2.0'; } });
  await h.commands.get('patina.installCli')();
  assert.equal(request.online, true); assert.equal(request.text, ''); assert.deepEqual(request.args, ['--version']); h.dispose();
});

test('disposal aborts a running rewrite and suppresses subsequent UI work', async () => {
  let finish; let signal;
  const h = host({ invoke: (request) => { signal = request.signal; return new Promise((resolve) => { finish = resolve; }); } });
  const pending = h.commands.get('patina.humanizeSelection')();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.dispose(); assert.equal(signal.aborted, true);
  finish({ output: 'After text.' }); await pending;
  assert.deepEqual(h.events, []); assert.equal(h.value(), 'Before text.');
});

test('automatic rewrite language is detected from the selection, even in a large foreign-language document', async () => {
  const selected = '오늘 작업한 내용을 정리했습니다. 내일 다시 확인하겠습니다.';
  const original = 'English background. '.repeat(15000) + selected;
  const requests = [];
  const h = host({ initialText: original, language: 'auto', backend: 'openai-http', invoke: async (request) => {
    requests.push(request);
    if (request.args[0] === 'inspect') return { schemaVersion: 1, sourceHash: checksum(request.text), language: 'ko', deterministicOnly: true, available: true, score: 0, diagnostics: [] };
    return { output: '변경된 문장입니다.' };
  } });
  h.editor.selection = { start: original.length - selected.length, end: original.length };
  await h.commands.get('patina.humanizeSelection')();
  assert.equal(requests[0].text, selected);
  assert.equal(requests[1].args[requests[1].args.indexOf('--lang') + 1], 'ko');
  assert.equal(requests[1].args[requests[1].args.indexOf('--backend') + 1], 'openai-http');
  assert.equal(h.value(), original); h.dispose();
});

test('disposal during editor operations prevents later confirmation, report display and edits', async () => {
  const diff = host({ choice: 'Apply' });
  diff.vscode.commands.executeCommand = async () => { diff.dispose(); };
  await diff.commands.get('patina.humanizeSelection')();
  assert.equal(diff.value(), 'Before text.'); assert.equal(diff.notices.length, 0);
  const show = host({ choice: 'Apply' });
  show.vscode.window.showTextDocument = async () => { show.dispose(); return show.editor; };
  await show.commands.get('patina.humanizeSelection')(); assert.equal(show.value(), 'Before text.');
  const audit = host(); let displayed = false;
  audit.vscode.workspace.openTextDocument = async () => { audit.dispose(); return {}; };
  audit.vscode.window.showTextDocument = async () => { displayed = true; };
  await audit.commands.get('patina.audit')(); assert.equal(displayed, false);
});

test('audit uses source-bound sentence ranges while stale responses cannot move diagnostics', async () => {
  const text = 'A calm sentence. Formulaic wording.';
  const inspection = { schemaVersion: 1, deterministicOnly: true, sourceHash: checksum(text), language: 'en', available: true, score: 100,
    diagnostics: [{ start: 0, end: text.length, scope: 'paragraph', localized: true, message: 'Paragraph', code: 'ai-like-paragraph' },
      { start: 17, end: text.length, scope: 'sentence', message: 'Sentence', code: 'ai-like-sentence' }] };
  const h = host({ initialText: text, invoke: async () => ({ output: 'Audit report.', inspection }) });
  await h.commands.get('patina.audit')();
  const rows = h.items.get(h.document.uri.toString()); assert.equal(rows.length, 1); assert.equal(rows[0].range.start, 17); h.dispose();
  let stale;
  stale = host({ initialText: text, invoke: async () => { stale.mutate('User changed it.'); return { output: 'Audit report.', inspection }; } });
  await stale.commands.get('patina.audit')(); assert.equal(stale.items.size, 0); stale.dispose();
});
