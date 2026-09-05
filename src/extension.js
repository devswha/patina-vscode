import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runPatina } from './cli.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
export function validateInspection(value, text) {
  if (value?.schemaVersion !== 1 || value.deterministicOnly !== true || value.sourceHash !== hash(text)
    || !['en', 'ko', 'zh', 'ja'].includes(value.language) || !Array.isArray(value.diagnostics)
    || (value.available && (!Number.isFinite(value.score) || value.score < 0 || value.score > 100))) throw new Error('Patina returned incompatible inspection data.');
  for (const row of value.diagnostics) if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end)
    || row.start < 0 || row.end <= row.start || row.end > text.length || typeof row.message !== 'string') throw new Error('Patina returned an invalid diagnostic range.');
  return value;
}

export function activate(context, vscode, { invoke = runPatina } = {}) {
  const diagnostics = vscode.languages.createDiagnosticCollection('patina');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'patina.score'; status.text = 'Patina'; status.show();
  const previews = new Map(); const jobs = new Map(); const timers = new Map();
  const actionControllers = new Set(); let disposed = false;
  const settings = (uri) => {
    const config = vscode.workspace.getConfiguration('patina', uri);
    return { cliPath: config.get('cliPath', 'npx patina-cli'), language: config.get('language', 'auto'),
      backend: config.get('backend', 'auto'), scoreThreshold: config.get('scoreThreshold', 30), autoScore: config.get('autoScore', true) };
  };
  const workingDirectory = (document) => vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath || (document.uri.scheme === 'file' ? dirname(document.uri.fsPath) : tmpdir());
  const trusted = () => { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running a local CLI.'); };
  async function inspect(document, explicit = false) {
    if (disposed || !document || document.isClosed || !['file', 'untitled'].includes(document.uri.scheme)) return null;
    trusted(); const key = document.uri.toString(); const text = document.getText(); const version = document.version;
    jobs.get(key)?.abort(); const controller = new AbortController(); jobs.set(key, controller);
    if (!text.trim()) { diagnostics.delete(document.uri); status.text = 'Patina'; return null; }
    const current = () => vscode.window.activeTextEditor?.document === document;
    if (current()) status.text = '$(sync~spin) Patina';
    try {
      const config = settings(document.uri);
      const result = validateInspection(await invoke({ cliPath: config.cliPath, args: ['inspect', '--lang', config.language], text,
        cwd: workingDirectory(document), signal: controller.signal, timeoutMs: 15000 }), text);
      if (disposed || controller.signal.aborted || document.isClosed || document.version !== version) return null;
      diagnostics.set(document.uri, result.diagnostics.map((row) => {
        const item = new vscode.Diagnostic(new vscode.Range(document.positionAt(row.start), document.positionAt(row.end)), row.message, vscode.DiagnosticSeverity.Warning);
        item.source = 'Patina'; item.code = row.code; return item;
      }));
      if (current()) {
        status.text = result.available ? `Patina ${Math.round(result.score)}` : 'Patina —';
        status.tooltip = result.available ? 'Local AI-writing signals; not an authorship verdict.' : 'Deterministic analysis is unavailable or disabled.';
        status.backgroundColor = result.available && result.score > config.scoreThreshold ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      }
      return result;
    } catch (error) {
      if (!controller.signal.aborted) { diagnostics.delete(document.uri); if (current()) { status.text = 'Patina !'; status.tooltip = error.message; } if (explicit) vscode.window.showErrorMessage(error.message); }
      return null;
    } finally { if (jobs.get(key) === controller) jobs.delete(key); }
  }
  function schedule(document) {
    if (!document || !vscode.workspace.isTrusted || !settings(document.uri).autoScore) return;
    const key = document.uri.toString(); clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); inspect(document).catch(() => {}); }, 500));
  }
  async function runAction(mode) {
    if (disposed) return;
    trusted(); const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document; const version = document.version; const original = document.getText();
    const range = mode === 'rewrite' ? editor.selection : new vscode.Range(document.positionAt(0), document.positionAt(original.length));
    const text = document.getText(range);
    if (!text.trim()) { vscode.window.showInformationMessage('Select text to rewrite.'); return; }
    const config = settings(document.uri);
    let language = config.language;
    if (language === 'auto') {
      const detectionText = mode === 'rewrite' ? text : text.slice(0, 12000);
      const controller = new AbortController(); actionControllers.add(controller);
      try {
        const result = validateInspection(await invoke({ cliPath: config.cliPath, args: ['inspect', '--lang', 'auto'], text: detectionText,
          cwd: workingDirectory(document), signal: controller.signal, timeoutMs: 15000 }), detectionText);
        if (disposed || controller.signal.aborted) return;
        language = result.language;
      } finally { actionControllers.delete(controller); }
    }
    const args = [mode === 'audit' ? '--audit' : '--verify', '--format', 'json', '--quiet', '--no-interactive', '--lang', language];
    if (config.backend !== 'auto') args.push('--backend', config.backend);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: mode === 'audit' ? 'Patina: auditing' : 'Patina: rewriting', cancellable: true }, async (_progress, token) => {
      const controller = new AbortController(); const listener = token.onCancellationRequested(() => controller.abort());
      actionControllers.add(controller);
      if (token.isCancellationRequested) controller.abort();
      try { return await invoke({ cliPath: config.cliPath, args, text, cwd: workingDirectory(document), signal: controller.signal }); }
      finally { listener.dispose(); actionControllers.delete(controller); }
    });
    if (disposed) return;
    if (typeof result.output !== 'string' || !result.output.trim()) throw new Error('Patina returned no text.');
    if (mode === 'audit') {
      const report = await vscode.workspace.openTextDocument({ language: 'markdown', content: result.output });
      if (!disposed) await vscode.window.showTextDocument(report, { preview: true });
      return;
    }
    if (result.output === text) { vscode.window.showInformationMessage('Patina kept the selection unchanged.'); return; }
    const id = randomUUID(); const before = vscode.Uri.parse(`patina-preview:${id}/original.md`); const after = vscode.Uri.parse(`patina-preview:${id}/rewrite.md`);
    previews.set(before.toString(), text); previews.set(after.toString(), result.output);
    try {
      await vscode.commands.executeCommand('vscode.diff', before, after, 'Patina rewrite preview', { preview: true });
      if (disposed) return;
      const choice = await vscode.window.showInformationMessage('Review the rewrite before applying it.', 'Apply', 'Discard');
      if (disposed || choice !== 'Apply') return;
      if (document.isClosed) throw new Error('The document was closed during rewriting. Run Patina again.');
      const target = await vscode.window.showTextDocument(document);
      if (disposed) return;
      if (target.document !== document || document.version !== version || document.getText() !== original) throw new Error('The document changed during rewriting. Run Patina again.');
      if (!await target.edit((edit) => edit.replace(range, result.output))) throw new Error('The document changed before the edit could be applied.');
    } finally { previews.delete(before.toString()); previews.delete(after.toString()); }
  }
  const command = (name, callback) => vscode.commands.registerCommand(name, async () => { try { return await callback(); } catch (error) { if (!disposed) vscode.window.showErrorMessage(error.message); } });
  async function installCli() {
    trusted(); if (disposed) return;
    const controller = new AbortController(); actionControllers.add(controller);
    try {
      const version = await invoke({ cliPath: settings().cliPath, args: ['--version'], text: '', online: true, json: false, signal: controller.signal });
      if (!disposed) vscode.window.showInformationMessage(`Patina CLI ready: ${version}`);
    } finally { actionControllers.delete(controller); }
  }
  context.subscriptions.push(diagnostics, status,
    vscode.workspace.registerTextDocumentContentProvider('patina-preview', { provideTextDocumentContent: (uri) => previews.get(uri.toString()) || '' }),
    command('patina.score', () => inspect(vscode.window.activeTextEditor?.document, true)),
    command('patina.installCli', installCli),
    command('patina.audit', () => runAction('audit')),
    command('patina.humanizeSelection', () => runAction('rewrite')),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => schedule(editor?.document)),
    vscode.workspace.onDidCloseTextDocument((document) => { const key = document.uri.toString(); clearTimeout(timers.get(key)); timers.delete(key); jobs.get(key)?.abort(); jobs.delete(key); diagnostics.delete(document.uri); }),
    { dispose() { disposed = true; for (const timer of timers.values()) clearTimeout(timer); for (const job of jobs.values()) job.abort(); for (const controller of actionControllers) controller.abort(); previews.clear(); } });
  schedule(vscode.window.activeTextEditor?.document);
  return { inspect, diagnostics, status };
}
