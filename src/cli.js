import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) for (const suffix of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
    const path = join(directory, name + suffix); if (existsSync(path)) return path;
  }
  return name;
}

export function cliCommand(cliPath = 'npx patina-cli', { online = false } = {}) {
  const npmArgs = [...(online ? [] : ['--offline']), '--yes', 'patina-cli@latest'];
  if (cliPath === 'npx patina-cli') {
    const npx = findExecutable('npx');
    if (existsSync(npx)) {
      const real = realpathSync(npx);
      const script = /\.cmd$/i.test(real) ? join(dirname(real), 'node_modules', 'npm', 'bin', 'npx-cli.js') : real;
      if (script.endsWith('.js') && existsSync(script)) return { command: 'node', args: [script, ...npmArgs] };
    }
    if (process.platform === 'win32') throw new Error('Install Node.js/npm so npx-cli.js is available.');
    return { command: 'npx', args: npmArgs };
  }
  if (!cliPath.trim() || /[\r\n\0]/.test(cliPath)) throw new Error('Invalid Patina executable path.');
  if (/\.[cm]?js$/i.test(cliPath)) return { command: 'node', args: [cliPath] };
  if (/\.(?:cmd|bat)$/i.test(cliPath)) throw new Error('Point cliPath to bin/patina.js instead of a command-shell wrapper.');
  return { command: cliPath, args: [] };
}

export async function runPatina({ cliPath, args, text, cwd = tmpdir(), signal, timeoutMs = 300000, online = false, json = true }) {
  if (signal?.aborted) throw new Error('Patina cancelled.');
  const resolved = cliCommand(cliPath, { online });
  const directory = mkdtempSync(join(tmpdir(), 'patina-editor-process-'));
  const statusPath = join(directory, 'status');
  const posix = process.platform !== 'win32';
  const shell = 'exec 3<&0; patina_status=$1; patina_seconds=$2; shift 2; trap ":" TERM; (sleep "$patina_seconds"; /bin/kill -KILL -- -$$) & "$@" <&3 & patina_cli=$!; wait "$patina_cli"; patina_exit=$?; printf "%s" "$patina_exit" > "$patina_status"; while :; do sleep 1; done';
  const command = posix ? '/bin/sh' : resolved.command;
  const arguments_ = posix ? ['-c', shell, 'patina-editor', statusPath, String(Math.ceil((timeoutMs + 2000) / 1000)), resolved.command, ...resolved.args, ...args] : [...resolved.args, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: posix });
    let stdout = ''; let bytes = 0; let failure; let exitCode; let killTimer;
    const kill = () => {
      if (!child.pid) return;
      if (posix) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      else { const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); taskkill.on('error', () => child.kill()); }
    };
    const stop = (message) => { if (failure) return; failure = new Error(message); if (posix) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} killTimer = setTimeout(kill, 1000); } else kill(); };
    const abort = () => stop('Patina cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Patina timed out.'), timeoutMs);
    const poll = posix ? setInterval(() => {
      if (!existsSync(statusPath)) return;
      const value = readFileSync(statusPath, 'utf8');
      if (/^\d{1,3}$/.test(value)) { exitCode = Number(value); kill(); }
    }, 10) : null;
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', (part) => { bytes += Buffer.byteLength(part); if (bytes > 4 * 1024 * 1024) stop('Patina output exceeded the limit.'); else stdout += part; });
    child.on('error', () => { failure = new Error('Could not start Patina. Check Node.js and patina.cliPath.'); });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killTimer); if (poll) clearInterval(poll); signal?.removeEventListener('abort', abort);
      rmSync(directory, { recursive: true, force: true });
      if (failure) return reject(failure);
      if ((posix ? exitCode : code) !== 0) return reject(new Error(`Patina exited with code ${posix ? exitCode : code}. Run Patina: Install or Update CLI, or check backend sign-in.`));
      try { resolve(json ? JSON.parse(stdout) : stdout.trim()); } catch { reject(new Error('Patina did not return JSON. Use a CLI version that supports patina inspect.')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(text);
  });
}
