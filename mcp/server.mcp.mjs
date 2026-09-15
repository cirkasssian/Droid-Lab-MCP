#!/usr/bin/env node
// webEmulator MCP — stdio-channel server for the AI agent.
// Single device-control layer — web/server.js (relay); MCP brings the environment up,
// operates the device over a WS connection to the relay and controls network access.
// Debug output strictly to stderr: the stdout channel is reserved for JSON-RPC.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PROJECT_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES_DIR = path.join(PROJECT_HOME, 'shots');
const EMULATOR_REGISTRY = path.join(PROJECT_HOME, 'mcp', 'emulators.json');

const RELAY_PORT = parseInt(process.env.BRIDGE_PORT || '8090', 10);
const PREFERRED_AVD = process.env.EMU_AVD || null;
const EMU_APPEND_ARGS = process.env.EMU_EXTRA_ARGS || '';
const BOOT_DEADLINE_MS = parseInt(process.env.BOOT_TIMEOUT_MS || '120000', 10);
const SCRCPY_VERSION = process.env.SCRCPY_VERSION || '4.1';

// --- portable paths and process management ---

const dataDir = () => {
  const base = process.platform === 'win32'
? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'droidlab')
     : process.platform === 'darwin'
       ? path.join(os.homedir(), 'Library', 'Application Support', 'droidlab')
       : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'droidlab');
  fs.mkdirSync(base, { recursive: true });
  return base;
};

const locateSdkTool = (rel) => {
  const exe = process.platform === 'win32' && !rel.endsWith('.exe') ? rel + '.exe' : rel;
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  else if (process.platform === 'win32') roots.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk'));
  else roots.push(path.join(os.homedir(), 'Android', 'Sdk'));
  for (const root of roots) {
    if (!root) continue;
    const p = path.join(root, exe);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return exe;
}

const emulatorExecutable = () => process.env.EMU_BIN || locateSdkTool(path.join('emulator', 'emulator'));

const ADB_EXEC = process.env.ADB || locateSdkTool(path.join('platform-tools', 'adb'));
const FFMPEG_EXEC = process.env.FFMPEG || 'ffmpeg';

// The cancellation signal (AbortSignal from MCP extra) is forwarded to execFile: on
// request cancellation (notifications/cancelled) the child process terminates immediately.
const execCmd = (bin, args, { timeout = 20000, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8', signal, env } = {}) => {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer, encoding, windowsHide: true, signal, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      if (signal?.aborted) reject(new Error(`cancelled by client: ${path.basename(String(bin))} ${args.slice(0, 2).join(' ')}`));
      else if (err && !stdout && !stderr) reject(err);
      else resolve({ stdout, stderr, code: err ? (err.code ?? 1) : 0, err });
    });
  });
};

const adbShell = async (cmd, timeout = 20000) => {
  const { stdout, code, err } = await execCmd(ADB_EXEC, ['shell', cmd], { timeout });
  if (code !== 0 && !stdout) {
    throw new Error(`adb '${cmd}' failed: ${err ? err.message : 'non-zero exit'}`);
  }
  return stdout;
};

const adbDeviceList = async () => {
  const { stdout } = await execCmd(ADB_EXEC, ['devices'], { timeout: 10000 });
  return stdout.split('\n').slice(1)
    .map((l) => l.split('\t'))
    .filter((p) => p.length === 2)
    .map(([serial, state]) => ({ serial: serial.trim(), state: state.trim() }));
};

const primaryEmuSerial = async () => {
  const devs = await adbDeviceList();
  return devs.find((d) => d.serial.startsWith('emulator-') && d.state === 'device')?.serial || null;
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// --- call cancellation and progress reporting (MCP) ---

// The client may cancel a request (notifications/cancelled) — long-running operations
// must poll the cancellation signal, otherwise the call will keep hanging in the background.
const assertNotAborted = (extra, what = 'operation') => {
  if (extra?.signal?.aborted) throw new Error(`cancelled by client: ${what}`);
};

// Progress is sent only when the client attached a progressToken to _meta.
const emitProgress = async (extra, progress, total, message) => {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return;
  try {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress, ...(total != null ? { total } : {}), ...(message ? { message } : {}) },
    });
  } catch { /* progress is not critical */ }
};

const processAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readProcCmdline = async (pid) => {
  if (!pid) return '';
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execCmd('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 8000 });
      return stdout.trim();
    } catch { return ''; }
  }
  try {
    const { stdout } = await execCmd('ps', ['-p', String(pid), '-o', 'command='], { timeout: 8000 });
    return stdout.trim();
  } catch { return ''; }
};

const terminateTree = async (pid, marker) => {
  if (!processAlive(pid)) return false;
  const cmd = await readProcCmdline(pid);
  if (marker && cmd && !cmd.includes(marker)) return false; // check: not our process — skip
  if (process.platform === 'win32') {
    await execCmd('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 }).catch(() => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  return true;
};

const locatePidsByCmdline = async (marker) => {
  const pids = [];
  if (process.platform === 'win32') {
    const { stdout } = await execCmd('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId`],
    { timeout: 20000 }).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) {
      const pid = parseInt(line.trim(), 10);
      if (Number.isFinite(pid)) pids.push(pid);
    }
    return pids;
  }
  if (process.platform === 'linux') {
    try {
      for (const e of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(e) || e === String(process.pid)) continue;
        const cmd = await readProcCmdline(parseInt(e, 10));
        if (cmd.includes(marker)) pids.push(parseInt(e, 10));
      }
    } catch {}
    return pids;
  }
  const { stdout } = await execCmd('ps', ['-axo', 'pid=,command='], { timeout: 20000 }).catch(() => ({ stdout: '' }));
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2].includes(marker)) pids.push(parseInt(m[1], 10));
  }
  return pids;
};

const awaitProcessExit = async (pid, timeoutMs, extra) => {
  const t0 = Date.now();
  while (processAlive(pid) && Date.now() - t0 < timeoutMs) {
    assertNotAborted(extra, 'waiting for process to exit');
    await pause(1000);
  }
  return !processAlive(pid);
};

// Stale AVD .lock files prevent a restart (error "Another emulator...").
// Removing them is acceptable only once the emulator's death is confirmed.
const purgeAvdLocks = (avdName) => {
  try {
    const avdDir = path.join(os.homedir(), '.android', 'avd', `${avdName}.avd`);
    for (const f of fs.readdirSync(avdDir)) {
      if (f.endsWith('.lock')) fs.rmSync(path.join(avdDir, f), { force: true });
    }
    const snapDir = path.join(avdDir, 'snapshots');
    if (fs.existsSync(snapDir)) {
      for (const s of fs.readdirSync(snapDir)) {
        const sd = path.join(snapDir, s);
        if (fs.statSync(sd).isDirectory()) {
          for (const f of fs.readdirSync(sd)) {
            if (f.endsWith('.lock')) fs.rmSync(path.join(sd, f), { force: true });
          }
        }
      }
    }
    return true;
  } catch { return false; }
};

const launchDetached = (bin, args, { env = {}, logName } = {}) => {
  const logFd = fs.openSync(path.join(dataDir(), logName), 'a');
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  child.unref();
  return child;
};

// --- PID files for running processes ---

const pidfileFor = (name) => path.join(dataDir(), `${name}.pid`);

const fetchPid = (name) => {
  try {
    const pid = parseInt(fs.readFileSync(pidfileFor(name), 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
};

const persistPid = (name, pid) => { fs.writeFileSync(pidfileFor(name), String(pid)); };

const dropPid = (name) => { try { fs.unlinkSync(pidfileFor(name)); } catch {}; }

// --- emulator registry (mcp/emulators.json) ---

const readEmulatorRegistry = () => {
  try {
    const arr = JSON.parse(fs.readFileSync(EMULATOR_REGISTRY, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};

const lookupAvd = (name) => {
  const entry = readEmulatorRegistry().find((e) => e.name === name || e.avd === name);
  return { avd: entry ? entry.avd : name, entry: entry || null };
};

const pickDefaultAvd = () => {
  if (PREFERRED_AVD) return lookupAvd(PREFERRED_AVD).avd;
  const cfg = readEmulatorRegistry();
  if (cfg.length && cfg[0].avd) return cfg[0].avd;
  throw new Error('AVD not specified: pass avd, set EMU_AVD or add an entry to mcp/emulators.json');
};

// --- relay bridge (web/server.js) ---

const RELAY_STATE = path.join(dataDir(), 'bridge.json');

const readRelayState = () => {
  try { return JSON.parse(fs.readFileSync(RELAY_STATE, 'utf8')); } catch { return null; }
};

const awaitHttpUp = async (url, timeoutMs) => {
  const t0 = Date.now();
  const isHttps = url.startsWith('https:');
  const mod = isHttps ? https : http;
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const opts = { timeout: 2000, ...(isHttps ? { rejectUnauthorized: false } : {}) };
      const req = mod.get(url, opts, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await pause(400);
  }
  throw new Error(`bridge did not come up at ${url} within ${Math.round(timeoutMs / 1000)}s`);
};

const bootRelay = async (host) => {
  try { await ensureScrcpyCached(null); } catch (e) { console.error(`[env] scrcpy bootstrap skipped: ${e.message}`); }
  const token = crypto.randomBytes(24).toString('hex');
  const accessToken = crypto.randomBytes(16).toString('hex');
  const child = launchDetached(process.execPath, [path.join(PROJECT_HOME, 'web', 'server.js')], {
    env: {
      HOST: host,
      PORT: String(RELAY_PORT),
      WEB_CONTROL_TOKEN: token,
      WEB_ACCESS_TOKEN: accessToken,
      ADB: ADB_EXEC,
      ...(scrcpyPathsCache ? { SCRCPY: scrcpyPathsCache.scrcpy, SCRCPY_SERVER: scrcpyPathsCache.server } : {}),
    },
    logName: 'bridge.log',
  });
  persistPid('bridge', child.pid);
  fs.writeFileSync(RELAY_STATE, JSON.stringify({ token, accessToken, host, port: RELAY_PORT, pid: child.pid }));
  await awaitHttpUp(`https://127.0.0.1:${RELAY_PORT}/state?token=${encodeURIComponent(accessToken)}`, 15000);
  return child.pid;
};

const shutRelay = async () => {
  const pid = fetchPid('bridge');
  let stopped = false;
  if (pid) stopped = await terminateTree(pid, 'server.js');
  dropPid('bridge');
  try { fs.unlinkSync(RELAY_STATE); } catch {}
  teardownRelay();
  return stopped || (pid ? processAlive(pid) === false : false);
};

const cycleRelay = async (host) => {
  await shutRelay();
  await bootRelay(host);
};

// --- WS channel to the relay (input, clipboard, input mode) ---

let relaySock = null;
let relayDialing = null; // promise cache: concurrent writes do not create a duplicate socket
let relayOutbox = Promise.resolve();
let clipPending = [];
let clipGate = Promise.resolve(); // clip-get requests go sequentially: scrcpy does not match responses to requests

const teardownRelay = () => {
  if (relaySock) { try { relaySock.close(); } catch {} }
  relaySock = null;
  relayDialing = null;
  relayOutbox = Promise.resolve();
};

const relayEndpoint = (info) => {
  const port = info?.port || RELAY_PORT;
  const token = info?.accessToken ? `?token=${encodeURIComponent(info.accessToken)}` : '';
  return `wss://127.0.0.1:${port}/${token}`;
};

const obtainRelay = async () => {
  if (relaySock && relaySock.readyState === WebSocket.OPEN) return relaySock;
  if (!relayDialing) {
    relayDialing = dialRelay().finally(() => { relayDialing = null; });
  }
  return relayDialing;
};

const dialRelay = async () => {
  const info = readRelayState();
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const sock = new WebSocket(relayEndpoint(info), { rejectUnauthorized: false });
        sock.on('open', () => {
          sock.send(JSON.stringify({ type: 'init', codec: 'none', token: info?.token }));
          relaySock = sock;
          resolve(sock);
        });
        sock.on('message', (data, isBinary) => {
          if (isBinary) return; // binary video frames are not needed by the agent
          try {
            const d = JSON.parse(data.toString());
            if (d.type === 'clip') {
              for (const w of clipPending.splice(0)) w(d);
            }
          } catch {}
        });
        sock.on('error', (e) => { if (relaySock !== sock) { lastErr = e; reject(e); } });
        sock.on('close', () => { if (relaySock === sock) relaySock = null; });
      });
    } catch (e) {
      lastErr = e;
      await pause(700);
    }
  }
  throw new Error(`bridge unavailable at 127.0.0.1:${info?.port || RELAY_PORT} (${lastErr?.message || 'no connection'}) — call env_start`);
};

const queueRelaySend = (sock, obj) => {
  const attempt = new Promise((resolve, reject) => {
    if (sock.readyState !== WebSocket.OPEN) {
      reject(new Error('bridge WS is closed — the input operation was not delivered'));
      return;
    }
    sock.send(JSON.stringify(obj), (err) => (err ? reject(new Error(`bridge WS send: ${err.message}`)) : resolve()));
  });
  // the queue is resilient to failures of past sends; each error goes to its own tool
  relayOutbox = relayOutbox.then(() => attempt, () => attempt);
  return relayOutbox;
};

const relayWrite = (obj) => {
  return obtainRelay().then((sock) => queueRelaySend(sock, obj));
};

const assertRelayOwned = () => {
  const info = readRelayState();
  if (!info?.token) {
    throw new Error('bridge was started without MCP (no token) — set_dev_input is unavailable; restart via env_start');
  }
  return info;
};

// --- emulator lifecycle ---

const emuProcessState = async (avd) => {
  const pid = fetchPid('emulator');
  if (pid && processAlive(pid)) {
    const cmd = await readProcCmdline(pid);
    if (cmd.includes('-avd') && cmd.includes(avd)) return { running: true, ours: true };
    return { running: true, ours: false, cmd };
  }
  const serial = await primaryEmuSerial();
  if (serial && await deviceBooted()) return { running: true, ours: false, adopted: true };
  return { running: false };
};

const awaitBoot = async (timeoutMs, extra) => {
  const t0 = Date.now();
  let lastProg = -1;
  while (Date.now() - t0 < timeoutMs) {
    assertNotAborted(extra, 'waiting for Android boot');
    if (await deviceBooted()) return;
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec - lastProg >= 5) {
      lastProg = sec;
      await emitProgress(extra, sec, Math.round(timeoutMs / 1000), 'waiting for Android boot');
    }
    await pause(2000);
  }
  throw new Error(`emulator did not boot within ${Math.round(timeoutMs / 1000)}s (log: ${path.join(dataDir(), 'emulator.log')})`);
};

// --- scrcpy self-bootstrap (h264 video source; downloaded on demand into ~/bin/scrcpy) ---

const SCRCPY_HOME = path.join(os.homedir(), 'bin', 'scrcpy');

const globScrcpyBin = (name) => {
  try {
    for (const e of fs.readdirSync(SCRCPY_HOME)) {
      const p = path.join(SCRCPY_HOME, e, name);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
};

const httpsDownload = (url, dest, extra, label) => new Promise((resolve, reject) => {
  const fetchOnce = (u, redirectsLeft) => {
    if (extra?.signal?.aborted) { reject(new Error(`cancelled by client: ${label}`)); return; }
    const req = https.get(u, { headers: { 'user-agent': 'droidlab-mcp' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        fetchOnce(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${label}: HTTP ${res.statusCode} from ${u}`)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.round((got / total) * 100);
          if (pct !== lastPct) { lastPct = pct; emitProgress(extra, pct, 100, `downloading ${label}`).catch(() => {}); }
        }
        if (extra?.signal?.aborted) {
          req.destroy(); out.destroy(); fs.rmSync(dest, { force: true });
          reject(new Error(`cancelled by client: ${label}`));
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', (e) => { fs.rmSync(dest, { force: true }); reject(e); });
      res.on('error', (e) => { out.destroy(); fs.rmSync(dest, { force: true }); reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`${label}: download timed out`)));
  };
  fetchOnce(url, 5);
});

const scrcpyAssetName = () => {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64';
  if (process.platform === 'linux') {
    if (process.arch !== 'x64') throw new Error(`scrcpy: no prebuilt asset for linux/${process.arch}`);
    return 'linux-x86_64';
  }
  throw new Error(`scrcpy auto-install is not supported on ${process.platform} — install it manually or set SCRCPY/SCRCPY_SERVER`);
};

let scrcpyPathsCache = null;
const ensureScrcpy = async (extra) => {
  const byEnv = (p) => (p && fs.existsSync(p) ? p : null);
  const scrcpy = byEnv(process.env.SCRCPY) || globScrcpyBin(process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  const server = byEnv(process.env.SCRCPY_SERVER) || globScrcpyBin('scrcpy-server');
  if (scrcpy && server) { scrcpyPathsCache = { scrcpy, server }; return scrcpyPathsCache; }
  const asset = scrcpyAssetName();
  fs.mkdirSync(SCRCPY_HOME, { recursive: true });
  if (!scrcpy) {
    const tgz = path.join(os.tmpdir(), `scrcpy-${asset}-v${SCRCPY_VERSION}.tar.gz`);
    await httpsDownload(`https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-${asset}-v${SCRCPY_VERSION}.tar.gz`, tgz, extra, `scrcpy v${SCRCPY_VERSION} (${asset})`);
    await execCmd('tar', ['-xzf', tgz, '-C', SCRCPY_HOME], { timeout: 120000 });
    fs.rmSync(tgz, { force: true });
  }
  const scrcpyBin = scrcpy || globScrcpyBin(process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  if (!scrcpyBin) throw new Error(`scrcpy was unpacked into ${SCRCPY_HOME}, but the binary was not found`);
  const dir = path.dirname(scrcpyBin);
  let serverBin = server;
  if (!serverBin) {
    serverBin = path.join(dir, 'scrcpy-server');
    await httpsDownload(`https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`, serverBin, extra, 'scrcpy-server');
  }
  try { fs.chmodSync(scrcpyBin, 0o755); } catch {}
  scrcpyPathsCache = { scrcpy: scrcpyBin, server: serverBin };
  return scrcpyPathsCache;
};
const ensureScrcpyCached = (extra) => (scrcpyPathsCache ? Promise.resolve(scrcpyPathsCache) : ensureScrcpy(extra));

const ensureRelayUp = async () => {
  try { await relayJson('/state'); return { started: false }; } catch {}
  await bootRelay('127.0.0.1');
  return { started: true };
};

// --- polling the state of the Android device ---

const relayJson = async (pathname) => {
  const info = readRelayState();
  const auth = info?.accessToken ? `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(info.accessToken)}` : '';
  const res = await new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port: info?.port || RELAY_PORT, path: pathname + auth, timeout: 4000, rejectUnauthorized: false }, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
  res.resume();
  if (res.statusCode !== 200) throw new Error(`${pathname} → HTTP ${res.statusCode}`);
  return JSON.parse(await new Promise((resolve, reject) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve(d));
    res.on('error', reject);
  }));
};

const deviceBooted = async () => {
  try { return (await adbShell('getprop sys.boot_completed', 8000)).trim() === '1'; } catch { return false; }
};

const frontmostApp = async () => {
  try {
    const out = await adbShell('dumpsys window', 15000);
    const m = out.match(/mCurrentFocus=Window\{[^}]*\s(u0\s+)([^}/]+)/);
    return m ? m[2] : null;
  } catch { return null; }
};

const collectStatus = async () => {
  const relayInfo = readRelayState();
  const relayProc = fetchPid('bridge');
  const emuProc = fetchPid('emulator');
  const status = {
    processes: {
      bridge: relayProc && processAlive(relayProc) ? { pid: relayProc } : null,
      emulator: emuProc && processAlive(emuProc) ? { pid: emuProc } : null,
    },
    bridge: null,
    adb: null,
  };
  try {
    const st = await relayJson('/state');
    status.bridge = {
      up: true, host: st.host, port: st.port,
      inputEnabled: st.inputEnabled, controlled: st.controlled, resolution: st.resolution,
    };
  } catch {
    status.bridge = { up: false };
  }
  try {
    const serial = await primaryEmuSerial();
    const boot = serial ? await deviceBooted() : false;
    status.adb = {
      device: serial || (await adbDeviceList()).map((d) => `${d.serial}(${d.state})`).join(', ') || null,
      booted: boot,
      androidVersion: boot ? (await adbShell('getprop ro.build.version.release', 8000)).trim() : null,
      sdk: boot ? (await adbShell('getprop ro.build.version.sdk', 8000)).trim() : null,
      screen: boot ? (await adbShell('wm size', 8000)).trim().split(': ').pop() : null,
      foregroundApp: boot ? await frontmostApp() : null,
    };
  } catch (e) {
    status.adb = { error: e.message };
  }
  return status;
};

const renderStatus = (s) => {
  const lines = [];
  for (const [k, v] of Object.entries(s.processes)) {
    lines.push(`${k}: ${v ? `running (pid ${v.pid})` : 'stopped'}`);
  }
  if (s.bridge.up) {
    lines.push(`bridge: http://${s.bridge.host === '0.0.0.0' ? '<lan-ip>' : s.bridge.host}:${s.bridge.port}, input=${s.bridge.inputEnabled ? 'enabled' : 'disabled'}${s.bridge.controlled ? ' (MCP-controlled)' : ''}, res=${s.bridge.resolution}`);
  } else {
    lines.push('bridge: down');
  }
  const a = s.adb;
  if (a.error) lines.push(`adb: error — ${a.error}`);
  else if (a.device) lines.push(`device: ${a.device}${a.booted ? `, Android ${a.androidVersion} (API ${a.sdk}), screen ${a.screen}${a.foregroundApp ? `, foreground: ${a.foregroundApp}` : ''}` : ', booting/not ready'}`);
  else lines.push('device: none');
  return lines.join('\n');
};

const mcp = new McpServer({ name: 'droidlab', version: '1.3.0' });

let startGate = false; // mutex: parallel env_start calls conflict over pidfiles and spawn

const replyText = (s) => ({ content: [{ type: 'text', text: s }] });
const replyError = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

mcp.registerTool(
  'env_start',
  {
    title: 'Start emulator environment',
    description: 'Start the environment: Android emulator (cold boot, the device state after env_stop is lost) + bridge on loopback. The first start takes ~30-60s (boot). If the emulator is already running — returns status (idempotent); for a different AVD run env_stop first. The bridge starts with browser input disabled until set_dev_input(true). Self-bootstrap: a missing AVD is created automatically (google_apis image for the host ABI is downloaded via sdkmanager, SDK licenses auto-accepted); missing cmdline-tools, java (Android Studio JBR) or scrcpy are downloaded/fetched too — network access is required.',
    inputSchema: {
      avd: z.string().optional().describe('Name from mcp/emulators.json ("android-13") or raw AVD name ("API33"). Default: EMU_AVD env, otherwise the first entry in the config.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ avd }, extra) => {
    if (startGate) return replyError(new Error('env_start is already running (parallel call) — wait for it to finish'));
    startGate = true;
    try {
      const name = avd || pickDefaultAvd();
      const { avd: avdName, entry } = lookupAvd(name);

      const emu = await emuProcessState(avdName);
      assertNotAborted(extra, 'env_start');
      if (emu.running && emu.ours === false && !emu.adopted) {
        return replyError(new Error(`another emulator is already running (${emu.cmd}) — call env_stop`));
      }

      let emulatorStarted = false;
      const bootstrapLog = [];
      if (!emu.running) {
        bootstrapLog.push(...await ensureAvd(avdName, entry, extra));

        const args = [
          '-avd', avdName,
          '-no-window', '-gpu', 'off', '-no-snapshot',
          '-memory', '2048', '-cores', '4',
          ...EMU_APPEND_ARGS.split(/\s+/).filter(Boolean),
        ];
        const bootLog = path.join(dataDir(), 'emulator.log');
        const spawnEmulator = () => {
          const child = launchDetached(emulatorExecutable(), args, {
            env: { ANDROID_HOME: process.env.ANDROID_HOME || path.dirname(path.dirname(ADB_EXEC)) },
            logName: 'emulator.log',
          });
          persistPid('emulator', child.pid);
          return child;
        };

        let child = spawnEmulator();
        emulatorStarted = true;

        const t0 = Date.now();
        while (!(await primaryEmuSerial())) {
          assertNotAborted(extra, 'starting the emulator');
          if (!processAlive(child.pid)) {
            // A common cause of failure — stale locks left by a previously exited emulator.
            // We remove the locks only when we are sure: there is no live emulator in adb.
            const log = fs.existsSync(bootLog) ? fs.readFileSync(bootLog, 'utf8').slice(-4000) : '';
            if (/Another emulator/i.test(log) && !(await primaryEmuSerial()) && avdName) {
              purgeAvdLocks(avdName);
              console.error('[env] AVD stale locks removed, retrying start');
              await pause(1500);
              child = spawnEmulator();
              continue;
            }
            throw new Error(`emulator crashed at start — see log ${bootLog}`);
          }
          if (Date.now() - t0 > 60000) throw new Error('emulator did not appear in adb within 60s');
          await emitProgress(extra, Math.round((Date.now() - t0) / 1000), 60, 'emulator is appearing in adb');
          await pause(1500);
        }
        await awaitBoot(BOOT_DEADLINE_MS, extra);
      }

      let scrcpyWarning = null;
      try { await ensureScrcpyCached(extra); }
      catch (e) { scrcpyWarning = `scrcpy bootstrap failed (${e.message}) — h264 video may not stream`; }

      const bridge = await ensureRelayUp();
      const status = await collectStatus();

      const parts = [];
      parts.push(...bootstrapLog);
      if (emu.adopted) parts.push('External (non-MCP) emulator detected — it is being used; env_stop will not stop it.');
      if (emulatorStarted) parts.push(`Emulator ${avdName} started (cold boot${entry?.note ? `, note: ${entry.note}` : ''}); the device state is lost on env_stop.`);
      else parts.push(`Emulator ${avdName} was already running.`);
      if (bridge.started) parts.push('Bridge started on loopback with a token: browser input is disabled until set_dev_input(true).');
      if (scrcpyWarning) parts.push(scrcpyWarning);
      parts.push(renderStatus(status));
      return replyText(parts.join('\n'));
    } catch (e) { return replyError(e); }
    finally { startGate = false; }
  },
);

mcp.registerTool(
  'env_stop',
  {
    title: 'Stop emulator environment',
    description: 'Stop the bridge, the emulator (adb emu kill, then forcibly). Safe shutdown: processes from pidfiles are verified by cmdline; an external emulator (started not via env_start) is left alone if it is not in a pidfile — except adb emu kill, which by definition targets the emulator.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (_, extra) => {
    try {
      assertNotAborted(extra, 'env_stop');
      const stopped = [];
      if (await shutRelay()) stopped.push('bridge');
      else { try { await relayJson('/state'); } catch { stopped.push('bridge (was not reachable)'); } }

      const serial = await primaryEmuSerial();
      if (serial) {
        await execCmd(ADB_EXEC, ['-s', serial, 'emu', 'kill'], { timeout: 15000 }).catch(() => {});
        const t0 = Date.now();
        while (await primaryEmuSerial() && Date.now() - t0 < 10000) {
          assertNotAborted(extra, 'graceful emulator shutdown');
          await pause(1000);
        }
      }
      const emuPid = fetchPid('emulator');
      if (emuPid) {
        const cmdline = await readProcCmdline(emuPid);
        const avdName = cmdline.match(/-avd\s+(\S+)/)?.[1] || null;
        if (!cmdline || cmdline.includes('-avd')) {
          // We wait for a clean exit: a SIGKILL during shutdown wedges qemu
          // in an uninterruptible kernel wait (rcu_barrier) and breaks subsequent starts
          let died = await awaitProcessExit(emuPid, 25000, extra);
          if (!died) {
            await terminateTree(emuPid, '-avd');
            died = await awaitProcessExit(emuPid, 15000, extra);
          }
          stopped.push(died ? `emulator (pid ${emuPid})` : `emulator pid ${emuPid} did NOT exit (kernel D-state?) — a host reboot is required`);
          // qemu can fork — we clean up by the AVD cmdline marker (verified cleanup)
          if (avdName) {
            const marker = `-avd ${avdName}`;
            for (const pid of await locatePidsByCmdline(marker)) {
              await terminateTree(pid, marker);
              await awaitProcessExit(pid, 10000, extra);
            }
            if (died && purgeAvdLocks(avdName)) stopped.push(`AVD ${avdName}: stale locks removed`);
          }
          dropPid('emulator');
        } else {
          stopped.push(`emulator pid ${emuPid} — not our process (no '-avd' in cmdline), not killed`);
        }
      } else {
        stopped.push('emulator (pidfile absent — external or already stopped)');
      }

      return replyText(`Stopped:\n- ${stopped.join('\n- ')}`);
    } catch (e) { return replyError(e); }
  },
);

// --- MCP tool registration ---

// We only account for our own artifacts (shot-*/uidump-*); we do not touch other files
const OWNED_CAPTURE_RE = /^(shot-|uidump-).+\.(png|jpg|xml)$/;

const ownedCaptures = () => {
  try {
    return fs.readdirSync(CAPTURES_DIR).filter((f) => OWNED_CAPTURE_RE.test(f)).sort().reverse(); // timestamp names: the newest first
  } catch { return []; }
};

const pruneCaptures = (max = 200) => {
  try {
    for (const f of ownedCaptures().slice(max)) fs.rmSync(path.join(CAPTURES_DIR, f), { force: true });
  } catch { /* rotation is not critical */ }
};

mcp.registerTool(
  'env_status',
  {
    title: 'Environment status',
    description: 'Environment status: processes (bridge/emulator), the device (boot, Android version, screen, foreground app), input mode, bridge address.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      summary: z.string(),
      processes: z.object({
        bridge: z.object({ pid: z.number() }).nullable(),
        emulator: z.object({ pid: z.number() }).nullable(),
      }),
      bridge: z.object({
        up: z.boolean(),
        host: z.string().optional(),
        port: z.number().optional(),
        inputEnabled: z.boolean().optional(),
        controlled: z.boolean().optional(),
        resolution: z.string().optional(),
      }),
      adb: z.object({
        device: z.string().nullable().optional(),
        booted: z.boolean().optional(),
        androidVersion: z.string().nullable().optional(),
        sdk: z.string().nullable().optional(),
        screen: z.string().nullable().optional(),
        foregroundApp: z.string().nullable().optional(),
        error: z.string().optional(),
      }),
    },
  },
  async () => {
    try {
      const s = await collectStatus();
      const summary = renderStatus(s);
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { summary, processes: s.processes, bridge: s.bridge, adb: s.adb },
      };
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'env_list',
  {
    title: 'List emulators',
    description: 'Entries of mcp/emulators.json + all AVDs discovered in the SDK (emulator -list-avds).',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      configured: z.array(z.object({ name: z.string(), avd: z.string(), note: z.string().optional() })),
      discovered: z.array(z.string()),
    },
  },
  async () => {
    try {
      const cfg = readEmulatorRegistry();
      const { stdout } = await execCmd(emulatorExecutable(), ['-list-avds'], { timeout: 15000 });
      const discovered = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const configured = new Set(cfg.map((e) => e.avd));
      const lines = [
        'Config (mcp/emulators.json):',
        ...(cfg.length ? cfg.map((e) => `- ${e.name} → AVD ${e.avd}${e.note ? ` (${e.note})` : ''}`) : ['- empty']),
        'Discovered AVDs without a config entry:',
        ...(discovered.filter((a) => !configured.has(a)).map((a) => `- ${a}`) || ['- none']),
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          configured: cfg.map((e) => ({ name: e.name, avd: e.avd, ...(e.note ? { note: e.note } : {}) })),
          discovered,
        },
      };
    } catch (e) { return replyError(e); }
  },
);

// --- system image and AVD management (SDK) ---

// SDK root used for self-bootstrap installs (first existing root, else the platform default, created on demand)
const sdkRootDir = () => {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  else if (process.platform === 'win32') roots.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk'));
  else roots.push(path.join(os.homedir(), 'Android', 'Sdk'));
  for (const r of roots) { if (r && fs.existsSync(r)) return r; }
  const def = roots.find(Boolean);
  fs.mkdirSync(def, { recursive: true });
  return def;
};

// cmdline-tools may be installed under a version dir (cmdline-tools/<ver>) instead of 'latest'
const cmdlineToolsBin = (tool) => {
  const exe = process.platform === 'win32' ? `${tool}.bat` : tool;
  const ctDir = path.join(sdkRootDir(), 'cmdline-tools');
  let versions = [];
  try { versions = fs.readdirSync(ctDir).sort().reverse(); } catch {}
  for (const v of ['latest', ...versions.filter((v) => v !== 'latest')]) {
    const p = path.join(ctDir, v, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

const sdkmanagerPath = () => {
  const p = path.join('cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
  const found = locateSdkTool(p);
  if (found !== p && fs.existsSync(found)) return found;
  const versioned = cmdlineToolsBin('sdkmanager');
  if (versioned) return versioned;
  const legacy = locateSdkTool(path.join('tools', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'));
  if (legacy !== path.join('tools', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager') && fs.existsSync(legacy)) return legacy;
  throw new Error('sdkmanager not found — install Android cmdline-tools (cmdline-tools/latest)');
};

const avdmanagerPath = () => {
  const p = path.join('cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager');
  const found = locateSdkTool(p);
  if (found !== p && fs.existsSync(found)) return found;
  const versioned = cmdlineToolsBin('avdmanager');
  if (versioned) return versioned;
  const legacy = locateSdkTool(path.join('tools', 'bin', process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'));
  if (legacy !== path.join('tools', 'bin', process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager') && fs.existsSync(legacy)) return legacy;
  throw new Error('avdmanager not found — install Android cmdline-tools (cmdline-tools/latest)');
};

// Self-bootstrap for the toolchain itself: when sdkmanager/avdmanager are absent,
// the official cmdline-tools package is downloaded into <sdk>/cmdline-tools/latest.
// If no system java exists, Android Studio's bundled JBR is wired into JAVA_HOME/PATH.
const CMDLINE_TOOLS_BUILD = '13114758';

const ensureJava = async () => {
  try { await execCmd('java', ['-version'], { timeout: 10000 }); return; } catch {}
  const jbr = process.platform === 'darwin'
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
    : process.platform === 'win32'
      ? path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Android', 'Android Studio', 'jbr')
      : null;
  const javaBin = jbr && fs.existsSync(path.join(jbr, process.platform === 'win32' ? 'bin/java.exe' : 'bin/java')) ? path.join(jbr, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : null;
  if (!javaBin) throw new Error('no java on PATH and no Android Studio JBR found — sdkmanager needs a JDK');
  process.env.JAVA_HOME = jbr;
  process.env.PATH = `${path.dirname(javaBin)}${path.delimiter}${process.env.PATH || ''}`;
};

const ensureCmdlineTools = async (extra) => {
  try { sdkmanagerPath(); avdmanagerPath(); return; } catch {}
  await emitProgress(extra, 0, 100, 'installing Android cmdline-tools').catch(() => {});
  await ensureJava();
  const osPart = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const sdkBase = sdkRootDir();
  const zip = path.join(os.tmpdir(), `commandlinetools-${osPart}-${CMDLINE_TOOLS_BUILD}.zip`);
  await httpsDownload(`https://dl.google.com/android/repository/commandlinetools-${osPart}-${CMDLINE_TOOLS_BUILD}_latest.zip`, zip, extra, 'Android cmdline-tools');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'droidlab-cmdline-'));
  try {
    await execCmd('unzip', ['-q', zip, '-d', tmp], { timeout: 180000 });
    const dest = path.join(sdkBase, 'cmdline-tools');
    fs.mkdirSync(dest, { recursive: true });
    const latest = path.join(dest, 'latest');
    const srcTools = path.join(tmp, 'cmdline-tools');
    if (fs.existsSync(latest) && !fs.existsSync(path.join(latest, 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'))) {
      fs.rmSync(latest, { recursive: true, force: true }); // replace an incomplete install only
    }
    if (!fs.existsSync(latest)) fs.renameSync(srcTools, latest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
  try { sdkmanagerPath(); avdmanagerPath(); }
  catch { throw new Error('cmdline-tools were installed, but sdkmanager/avdmanager are still not found'); }
};

const presentImages = () => {
  const imgRoot = path.join(sdkRootDir(), 'system-images');
  const collected = [];
  try {
    for (const apiLv of fs.readdirSync(imgRoot)) {
      const apiPath = path.join(imgRoot, apiLv);
      if (!fs.statSync(apiPath).isDirectory()) continue;
      for (const tagLv of fs.readdirSync(apiPath)) {
        const tagPath = path.join(apiPath, tagLv);
        if (!fs.statSync(tagPath).isDirectory()) continue;
        for (const abiLv of fs.readdirSync(tagPath)) {
          if (fs.existsSync(path.join(tagPath, abiLv, 'system.img'))) {
            collected.push(`system-images;${apiLv};${tagLv};${abiLv}`);
          }
        }
      }
    }
  } catch {}
  return collected.sort();
};

const IMAGE_PKG_RE = /^system-images;android-(\d+);([\w.-]+);([\w-]+)$/;

const splitSdkmanagerList = (stdout) => {
  // Lines of the form: "  system-images;android-33;google_apis;x86_64 | 17 | Description"
  const lines = stdout.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.includes('system-images;'));
  const available = new Map();
  for (const l of lines) {
    const pkg = l.split('|')[0].trim();
    if (IMAGE_PKG_RE.test(pkg) && !available.has(pkg)) available.set(pkg, true);
  }
  return [...available.keys()].sort();
};

// Shared core of system_image_install and the env_start AVD self-bootstrap.
// Pending SDK licenses are auto-accepted ('y') so a fresh machine does not stall on the prompt.
const installImage = (pkg, extra) => new Promise((resolve, reject) => {
  const LIMIT_MS = 30 * 60 * 1000;
  const child = spawn(sdkmanagerPath(), ['--install', pkg], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '', errOut = '', lastPct = -1, killReason = null;
  const timer = setTimeout(() => { killReason = '30-minute limit exceeded'; child.kill('SIGKILL'); }, LIMIT_MS);
  const abortWatch = setInterval(() => {
    if (extra?.signal?.aborted && !killReason) { killReason = 'cancelled by client'; child.kill('SIGKILL'); }
  }, 1000);
  child.stdout.on('data', (c) => {
    out += c;
    const pcts = [...out.matchAll(/\[(\d+)%\]/g)]; // sdkmanager output: "[ 42%] ..."
    if (pcts.length) {
      const pct = parseInt(pcts[pcts.length - 1][1], 10);
      if (pct !== lastPct) { lastPct = pct; emitProgress(extra, pct, 100, 'downloading image').catch(() => {}); }
    }
  });
  child.stderr.on('data', (c) => { errOut += c; });
  child.on('error', (e) => { clearTimeout(timer); clearInterval(abortWatch); reject(e); });
  child.on('close', (c) => {
    clearTimeout(timer); clearInterval(abortWatch);
    if (killReason) reject(new Error(`sdkmanager aborted: ${killReason}`));
    else resolve({ stdout: out, stderr: errOut, code: c ?? 1 });
  });
  child.stdin.write('y\n'.repeat(50));
  child.stdin.end();
});

// env_start self-bootstrap: a missing AVD is created from a system image derived
// from its name (API33 → system-images;android-33;google_apis;<host ABI>).
const ensureAvd = async (avdName, entry, extra) => {
  const log = [];
  await ensureCmdlineTools(extra);
  const listAvds = async () => (await execCmd(emulatorExecutable(), ['-list-avds'], { timeout: 15000 })).stdout.split('\n').map((s) => s.trim());
  if ((await listAvds()).includes(avdName)) return log;
  const api = avdName.match(/^API(\d+)$/i)?.[1];
  if (!api) throw new Error(`AVD ${avdName} does not exist and its API level cannot be derived from the name (expected API<N>) — create it via avd_create`);
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const pkg = `system-images;android-${api};google_apis;${abi}`;
  log.push(`AVD ${avdName} is missing — self-bootstrap: ${pkg}`);
  if (!presentImages().includes(pkg)) {
    const avail = splitSdkmanagerList((await execCmd(sdkmanagerPath(), ['--list'], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 })).stdout);
    if (!avail.includes(pkg)) {
      const sameApi = avail.filter((p) => p.startsWith(`system-images;android-${api};`));
      throw new Error(`image ${pkg} is not available for download. Alternatives for this API level: ${sameApi.join(', ') || 'none'}`);
    }
    const { code, stderr, stdout } = await installImage(pkg, extra);
    if (code !== 0) throw new Error(`sdkmanager --install ${pkg} failed (code ${code}):\n${(stderr || stdout).trim().split('\n').slice(-5).join('\n')}`);
    if (!presentImages().includes(pkg)) throw new Error(`image ${pkg} was not found after install (check sdkmanager output)`);
    log.push(`image installed: ${pkg} (pixel_7 device profile on AVD creation)`);
  }
  const avdRoot = path.join(os.homedir(), '.android', 'avd');
  fs.mkdirSync(avdRoot, { recursive: true });
  await execCmd(avdmanagerPath(), ['create', 'avd', '-n', avdName, '-k', pkg, '-d', 'pixel_7', '--force'],
    { timeout: 60000, env: { ANDROID_AVD_HOME: avdRoot, ANDROID_SDK_HOME: os.homedir() } });
  if (!(await listAvds()).includes(avdName)) throw new Error(`AVD ${avdName} did not appear after avdmanager`);
  log.push(`AVD created: ${avdName}`);
  const cfg = readEmulatorRegistry();
  if (!cfg.some((e) => e.avd === avdName)) {
    cfg.push({ name: entry?.name || `android-${api}`, avd: avdName, note: `google_apis/${abi}` });
    fs.writeFileSync(EMULATOR_REGISTRY, JSON.stringify(cfg, null, 2) + '\n');
    log.push(`registered in mcp/emulators.json`);
  }
  return log;
};

mcp.registerTool(
  'system_images_list',
  {
    title: 'List Android system images',
    description: 'Android system images: installed (from the SDK directory) and available for download (sdkmanager --list).',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      installed: z.array(z.string()),
      downloadable: z.array(z.string()),
    },
  },
  async () => {
    try {
      const installed = presentImages();
      const { stdout } = await execCmd(sdkmanagerPath(), ['--list'], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
      const remote = splitSdkmanagerList(stdout);
      const installedSet = new Set(installed);
      const downloadable = remote.filter((p) => !installedSet.has(p));
      const lines = [
        `Installed (${installed.length}):`,
        ...(installed.length ? installed.map((p) => `- ${p}`) : ['- none']),
        `Available for download (${downloadable.length}):`,
        ...downloadable.map((p) => `- ${p}`),
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { installed, downloadable },
      };
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'system_image_install',
  {
    title: 'Download Android system image',
    description: 'Download a system image (sdkmanager --install). A package from system_images_list, e.g. system-images;android-34;google_apis;x86_64. Pending SDK licenses are auto-accepted (y). Installation takes minutes, hard limit 30 min; supports client cancellation and reports download progress.',
    inputSchema: {
      package: z.string().regex(IMAGE_PKG_RE, 'system-images;android-N;tag;abi'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ package: pkg }, extra) => {
    try {
      const { code } = await installImage(pkg, extra);
      if (code !== 0) throw new Error(`sdkmanager returned code ${code}`);
      const installed = presentImages().includes(pkg);
      return replyText([
        installed ? `Image installed: ${pkg}` : `sdkmanager ran, but the image directory was not found (check manually): ${pkg}`,
        `Total images installed: ${presentImages().length}`,
      ].join('\n'));
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'avd_create',
  {
    title: 'Create AVD from system image',
    description: 'Create an AVD from a system image (avdmanager create avd, device pixel_7) and add an entry to mcp/emulators.json. The tag/ABI are taken from the package.',
    inputSchema: {
      name: z.string().regex(/^[\w-]+$/, 'AVD name (letters, digits, _ and -)').describe('Name of the new AVD, e.g. API34'),
      package: z.string().regex(IMAGE_PKG_RE, 'system-images;android-N;tag;abi').describe('An installed image from system_images_list'),
      alias: z.string().optional().describe('Human-readable name for emulators.json (default name)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ name, package: pkg, alias }) => {
    try {
      const m = pkg.match(IMAGE_PKG_RE);
      const [, , tag, abi] = m;
      if (!presentImages().includes(pkg)) {
        throw new Error(`image not installed: ${pkg} — run system_image_install first`);
      }
      const avdRoot = path.join(os.homedir(), '.android', 'avd');
      fs.mkdirSync(avdRoot, { recursive: true });
      const { stdout } = await execCmd(avdmanagerPath(), [
        'create', 'avd',
        '-n', name,
        '-k', pkg,
        '-d', 'pixel_7',
        '--force',
      ], { timeout: 60000, env: { ANDROID_AVD_HOME: avdRoot, ANDROID_SDK_HOME: os.homedir() } });
      // avdmanager writes "Loading..." to stderr — we ignore it and check the result
      const listOut = await execCmd(emulatorExecutable(), ['-list-avds'], { timeout: 15000 });
      if (!listOut.stdout.split('\n').map((s) => s.trim()).includes(name)) {
        throw new Error(`AVD ${name} did not appear after avdmanager: ${(stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
      }
      // saving the entry to emulators.json
      const cfg = readEmulatorRegistry();
      const entryName = alias || `android-${name.replace(/^API/i, '')}`;
      if (!cfg.some((e) => e.avd === name)) {
        cfg.push({ name: entryName, avd: name, note: `${tag}/${abi}` });
        fs.writeFileSync(EMULATOR_REGISTRY, JSON.stringify(cfg, null, 2) + '\n');
      }
      return replyText([
        `AVD created: ${name} (${pkg}, pixel_7)`,
        `Entry in emulators.json: "${entryName}" → AVD ${name}`,
        'Start: env_start({avd: "' + entryName + '"}) — before starting another AVD, run env_stop first.',
      ].join('\n'));
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'screenshot',
  {
    title: 'Device screenshot',
    description: 'Screenshot of the device screen at full resolution (adb screencap PNG, ~1080x2400): the full PNG is saved to shots/, and a downscaled JPEG (~720x1600) is returned in the response. Multiply UI coordinates from the downscaled image by 1.5 for tap/swipe (native pixels). ui_dump is faster for exact element coordinates.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const pngPath = path.join(CAPTURES_DIR, `shot-${stamp}.png`);
      const { stdout: png } = await execCmd(ADB_EXEC, ['exec-out', 'screencap', '-p'], { timeout: 30000, encoding: 'buffer' });
      if (!png || png.length < 100) throw new Error('screencap returned an empty frame — is the device booting?');
      fs.writeFileSync(pngPath, png);

      const jpgPath = pngPath.replace(/\.png$/, '.jpg');
      let inlineBuf = null;
      try {
        await execCmd(FFMPEG_EXEC, ['-y', '-i', pngPath, '-vf', 'scale=720:1600', '-q:v', '3', jpgPath], { timeout: 20000 });
        inlineBuf = fs.readFileSync(jpgPath);
      } catch (e) {
        // We do not put the full PNG (1-3 MB of base64) into the context — bloating the agent
        // costs more than a missing thumbnail; the file is available via the resource droidlab://shots/<name>
        console.error('[screenshot] ffmpeg resize failed, inline skipped:', e.message);
      }
      pruneCaptures();
      const name = path.basename(pngPath);
      const content = [];
      if (inlineBuf) content.push({ type: 'image', data: inlineBuf.toString('base64'), mimeType: 'image/jpeg' });
      content.push(
        { type: 'text', text: `Screenshot: ${pngPath} (${png.length} bytes, full PNG${inlineBuf ? '' : '; no preview — ffmpeg unavailable'}). Coordinates for tap/swipe — device native pixels; in the displayed image multiply by 1.5.` },
        { type: 'resource_link', uri: `droidlab://shots/${name}`, name, mimeType: 'image/png' },
      );
      return { content };
    } catch (e) { return replyError(e); }
  },
);

const KEYCODE_TABLE = {
  home: 3, back: 4, menu: 82, power: 26, recents: 187,
  volume_up: 24, volume_down: 25, mute: 164,
  enter: 66, del: 67, tab: 61, esc: 111, escape: 111, space: 62,
  arrow_up: 19, arrow_down: 20, arrow_left: 21, arrow_right: 22,
  search: 84, camera: 27, call: 5, endcall: 6,
};

const translateKey = (k) => {
  if (typeof k === 'number') return k;
  const name = String(k).toLowerCase();
  if (!(name in KEYCODE_TABLE)) {
    throw new Error(`unknown key '${k}' — allowed: ${Object.keys(KEYCODE_TABLE).join(', ')} or a numeric Android keycode`);
  }
  return KEYCODE_TABLE[name];
};

mcp.registerTool(
  'tap',
  {
    title: 'Tap device screen',
    description: 'Tap on the device screen in NATIVE pixels (screen 1080x2400).',
    inputSchema: {
      x: z.number().int().min(0).max(1080).describe('X in native pixels'),
      y: z.number().int().min(0).max(2400).describe('Y in native pixels'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ x, y }) => {
    try { await relayWrite({ type: 'tap', x, y }); return replyText(`tap ${x},${y}`); }
    catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'swipe',
  {
    title: 'Swipe on device screen',
    description: 'Swipe from point to point in native pixels. Long press = swipe(x,y,x,y,ms=800).',
    inputSchema: {
      x1: z.number().int().min(0).max(1080), y1: z.number().int().min(0).max(2400),
      x2: z.number().int().min(0).max(1080), y2: z.number().int().min(0).max(2400),
      ms: z.number().int().min(50).max(10000).optional().describe('Duration, ms (default 300)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ x1, y1, x2, y2, ms }) => {
    try { await relayWrite({ type: 'swipe', x1, y1, x2, y2, ms }); return replyText(`swipe ${x1},${y1} → ${x2},${y2}`); }
    catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'scroll',
  {
    title: 'Scroll on device screen',
    description: 'Scroll at a point: dy > 0 — down, dy < 0 — up (number of "clicks").',
    inputSchema: {
      x: z.number().int().min(0).max(1080), y: z.number().int().min(0).max(2400),
      dy: z.number().int().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ x, y, dy }) => {
    try { await relayWrite({ type: 'scroll', x, y, dy: dy ?? 1 }); return replyText(`scroll ${x},${y} dy=${dy ?? 1}`); }
    catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'key',
  {
    title: 'Press device key',
    description: `Press a key: a name (${Object.keys(KEYCODE_TABLE).join(', ')}) or a numeric Android keycode.`,
    inputSchema: {
      key: z.union([z.string(), z.number()]).describe('Key name or keycode'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ key }) => {
    try {
      const code = translateKey(key);
      await relayWrite({ type: 'key', code });
      return replyText(`key ${key} → keycode ${code}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'text',
  {
    title: 'Type text on device',
    description: 'Type text into the focused device field (Unicode/Cyrillic are supported via ADBKeyBoard). Long strings are automatically split into parts.',
    inputSchema: {
      text: z.string().min(1).max(5000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text: value }) => {
    try {
      const CHUNK = 180;
      for (let i = 0; i < value.length; i += CHUNK) {
        await relayWrite({ type: 'text', text: value.slice(i, i + CHUNK) });
        if (i + CHUNK < value.length) await pause(60);
      }
      return replyText(`entered ${value.length} characters`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'clipboard_get',
  {
    title: 'Get device clipboard',
    description: 'Read the device clipboard. Note: scrcpy suppresses re-sending UNCHANGED text — if the buffer has not changed since the last read, the response will not arrive within 5s (a note about it is returned; the control channel may also simply be busy). Parallel calls are serialized.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const info = readRelayState();
      // scrcpy clipboard responses are not tied to requests — we poll one at a time
      const attempt = async () => {
        const sock = await obtainRelay();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(null), 5000);
          clipPending.push((d) => { clearTimeout(timer); resolve(d); });
          queueRelaySend(sock, { type: 'clip-get', token: info?.token }).catch((e) => { clearTimeout(timer); reject(e); });
        });
      };
      const p = clipGate.then(attempt, attempt);
      clipGate = p.then(() => {}, () => {});
      const result = await p;
      if (result === null) {
        return replyText('No response within 5s — most likely the buffer has not changed since the last read (scrcpy suppresses re-sending duplicates); or the control channel is busy. Write a new value (clipboard_set) or retry.');
      }
      return replyText(`Device clipboard: ${JSON.stringify(result.text ?? '')}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'clipboard_set',
  {
    title: 'Set device clipboard',
    description: 'Write text to the device clipboard; paste=true — additionally paste into the focused field (a repeat call with paste duplicates the input — not idempotent).',
    inputSchema: {
      text: z.string(),
      paste: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ text: value, paste }) => {
    try { await relayWrite({ type: 'clip-set', text: value, paste: !!paste }); return replyText('clipboard set'); }
    catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'install_apk',
  {
    title: 'Install APK',
    description: 'Install an APK on the device: adb install -r -t. The path is to a file on the machine with the emulator. Supports client cancellation (may take up to several minutes).',
    inputSchema: {
      path: z.string().describe('Absolute or relative path to the .apk'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ path: apkPath }, extra) => {
    try {
      const abs = path.resolve(apkPath);
      if (!apkPath.toLowerCase().endsWith('.apk')) throw new Error('a .apk is expected');
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
      await emitProgress(extra, 0, undefined, `adb install ${fs.statSync(abs).size} bytes — may take up to several minutes`);
      const { stdout } = await execCmd(ADB_EXEC, ['install', '-r', '-t', abs], { timeout: 300000, signal: extra?.signal });
      return replyText(`adb install:\n${stdout.trim().split('\n').slice(-3).join('\n')}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'push_file',
  {
    title: 'Push file to device',
    description: 'Copy a file to the device (adb push). Supports client cancellation.',
    inputSchema: {
      src: z.string().describe('Path on the machine with the emulator'),
      dst: z.string().describe('Path on the device, e.g. /sdcard/Download/'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ src, dst }, extra) => {
    try {
      const abs = path.resolve(src);
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
      await emitProgress(extra, 0, undefined, `adb push ${fs.statSync(abs).size} bytes`);
      const { stdout } = await execCmd(ADB_EXEC, ['push', abs, dst], { timeout: 300000, signal: extra?.signal });
      return replyText(`adb push:\n${stdout.trim()}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'open_app',
  {
    title: 'Launch app by package',
    description: 'Launch an app by package name (monkey → LAUNCHER intent), e.g. com.android.settings.',
    inputSchema: {
      package: z.string().regex(/^[\w.]+$/, 'package name'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ package: pkg }) => {
    try {
      const { stdout } = await execCmd(ADB_EXEC, ['shell', `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`], { timeout: 30000 });
      if (!stdout.includes('Events injected: 1')) throw new Error(`failed to launch: ${stdout.trim().split('\n').slice(-3).join(' | ')}`);
      await pause(600);
      const fg = await frontmostApp();
      return replyText(`Launched ${pkg}${fg ? `, foreground: ${fg}` : ''}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'deep_link',
  {
    title: 'Open deep link / URI',
    description: 'Open a URI on the device (am start -a android.intent.action.VIEW): https links, app links, app schemes (myapp://...). An optional package force-selects the handler (-p).',
    inputSchema: {
      uri: z.string().regex(/^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s'"]+$/, 'URI with a scheme, no spaces or quotes').describe('E.g. https://example.com/path or myapp://screen/Detail'),
      package: z.string().regex(/^[\w.]+$/, 'package name').optional().describe('Launch in a specific app'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ uri, package: pkg }) => {
    try {
      const safe = uri.replace(/'/g, ''); // inside the device shell's single quotes
      const out = await adbShell(`am start -a android.intent.action.VIEW -d '${safe}'${pkg ? ` -p ${pkg}` : ''}`, 30000);
      if (/Error|Exception|Cannot|does not exist/i.test(out)) {
        throw new Error(`am start rejected the URI: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      }
      await pause(600);
      const fg = await frontmostApp();
      return replyText(`Opened: ${uri}${pkg ? ` (package ${pkg})` : ''}${fg ? `, foreground: ${fg}` : ', foreground: —'}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'app_list',
  {
    title: 'List installed apps',
    description: 'Installed packages (default: third-party only; system=true — including system). filter — a substring for selection (case-insensitive), so you do not pull hundreds of lines. The package name is for open_app/close_app.',
    inputSchema: {
      system: z.boolean().optional().describe('true — also show system packages'),
      filter: z.string().min(2).optional().describe('Substring of the package name (case-insensitive)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ system, filter }) => {
    try {
      const out = await adbShell(`pm list packages${system ? '' : ' -3'}`, 30000);
      const f = filter?.toLowerCase();
      const pkgs = out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean)
        .filter((p) => !f || p.toLowerCase().includes(f)).sort();
      if (!pkgs.length) throw new Error(filter ? `no packages containing '${filter}'` : 'pm list packages returned empty');
      return replyText(`${system ? 'All' : 'Third-party'} packages${filter ? ` by filter '${filter}'` : ''} (${pkgs.length}):\n${pkgs.join('\n')}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'close_app',
  {
    title: 'Force-stop app',
    description: 'Force-stop an app (am force-stop) — works even for hung apps. The package is from app_list.',
    inputSchema: {
      package: z.string().regex(/^[\w.]+$/, 'package name'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ package: pkg }) => {
    try {
      try { await adbShell(`pm path ${pkg}`, 15000); } catch { throw new Error(`package not found: ${pkg} — see app_list`); }
      await adbShell(`am force-stop ${pkg}`, 15000);
      const fg = await frontmostApp();
      return replyText(`Stopped: ${pkg}${fg ? `, foreground now: ${fg}` : ', foreground: —'}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'app_permission',
  {
    title: 'Grant/revoke app permission',
    description: 'Grant (grant=true) or revoke an app runtime permission (pm grant/revoke). Works only with dangerous permissions declared in the app manifest (otherwise pm refuses — that is normal).',
    inputSchema: {
      package: z.string().regex(/^[\w.]+$/, 'package name'),
      permission: z.string().regex(/^[\w.]+$/, 'e.g. android.permission.CAMERA'),
      grant: z.boolean().describe('true — grant, false — revoke'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ package: pkg, permission, grant }) => {
    try {
      try { await adbShell(`pm path ${pkg}`, 15000); } catch { throw new Error(`package not found: ${pkg} — see app_list`); }
      const { stdout, stderr, code } = await execCmd(ADB_EXEC,
        ['shell', `pm ${grant ? 'grant' : 'revoke'} ${pkg} ${permission}`], { timeout: 15000 });
      const all = `${stdout}\n${stderr}`;
      if (code !== 0 || /Exception|Error|Unknown permission|not a runtime permission/i.test(all)) {
        throw new Error(`pm ${grant ? 'grant' : 'revoke'} rejected: ${(all.trim() || 'empty response').split('\n').slice(-3).join(' | ')} (the permission must be dangerous and declared in the manifest)`);
      }
      return replyText(`${grant ? 'Granted' : 'Revoked'}: ${permission} → ${pkg}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'pull_file',
  {
    title: 'Pull file from device',
    description: 'Download a file from the device (adb pull) to the emulator machine. If dst is not set — saves to pulled/<file name> in the project root. Supports client cancellation.',
    inputSchema: {
      src: z.string().min(1).describe('Path on the device, e.g. /sdcard/Download/report.txt'),
      dst: z.string().optional().describe('Local file or directory (default pulled/<basename>)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ src, dst }, extra) => {
    try {
      const dir = path.join(PROJECT_HOME, 'pulled');
      fs.mkdirSync(dir, { recursive: true });
      const local = dst ? path.resolve(dst) : path.join(dir, path.basename(src));
      await emitProgress(extra, 0, undefined, `adb pull ${src}`);
      const { stdout } = await execCmd(ADB_EXEC, ['pull', src, local], { timeout: 300000, signal: extra?.signal });
      if (!fs.existsSync(local)) throw new Error(`file was not downloaded: ${stdout.trim()}`);
      const size = fs.statSync(local).size;
      return replyText(`Saved: ${local} (${size} bytes)\n${stdout.trim()}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'logcat',
  {
    title: 'Read device log',
    description: 'A snapshot of the device log (logcat -d, not a stream): the last N lines, an optional filter-spec (e.g. "ActivityManager:I *:S") and a substring filter (case-insensitive).',
    inputSchema: {
      lines: z.number().int().min(1).max(2000).optional().describe('The last N lines (default 200)'),
      filter: z.string().regex(/^[\w./*: ,_-]+$/, 'filter-spec without quotes').optional().describe('logcat filter-spec, e.g. "ActivityManager:I *:S"'),
      grep: z.string().optional().describe('Substring for line selection (case-insensitive)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ lines = 200, filter, grep }) => {
    try {
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      // The filter in single quotes: '*' must not be interpreted by the device shell
      const cmd = `logcat -d -t ${lines}${filter ? ` '${filter}'` : ''}`;
      const { stdout } = await execCmd(ADB_EXEC, ['-s', serial, 'shell', cmd], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      let rows = stdout.split('\n').map((s) => s.trimEnd()).filter(Boolean);
      if (grep) { const g = grep.toLowerCase(); rows = rows.filter((r) => r.toLowerCase().includes(g)); }
      if (!rows.length) return replyText('Log is empty — no matches by the filter.');
      let body = rows.join('\n');
      if (body.length > 60000) body = `${body.slice(-60000)}\n[truncated by size — narrow filter/grep]`;
      return replyText(`logcat (${rows.length} lines):\n${body}`);
    } catch (e) { return replyError(e); }
  },
);

// uiautomator XML → a compact tree with element centers (coordinates for tap)
const renderUiTree = (xml) => {
  const out = [];
  let depth = 0;
  const tagRe = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let m;
  for (; (m = tagRe.exec(xml));) {
    const [, close, raw, selfClose] = m;
    if (close) { depth = Math.max(0, depth - 1); continue; }
    const get = (k) => { const a = raw.match(new RegExp(`\\b${k}="([^"]*)"`)); return a ? a[1] : ''; };
    const cls = (get('class') || '?').split('.').pop();
    const b = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (b) {
      const [x1, y1, x2, y2] = b.slice(1).map(Number);
        if (x2 > x1 && y2 > y1) { // zero-sized (invisible) elements are skipped
        const t = get('text'), desc = get('content-desc'), rid = get('resource-id');
        const flags = [get('clickable') === 'true' && 'click', get('scrollable') === 'true' && 'scroll'].filter(Boolean).join(',');
        const parts = [cls];
        if (t) parts.push(`text=${JSON.stringify(t)}`);
        if (desc) parts.push(`desc=${JSON.stringify(desc)}`);
        if (rid) parts.push(`rid=${rid}`);
        const center = `center(${Math.round((x1 + x2) / 2)},${Math.round((y1 + y2) / 2)})`;
        out.push(`${'  '.repeat(depth)}- ${parts.join(' ')}${flags ? ` [${flags}]` : ''} ${center}`);
      }
    }
    if (!selfClose) depth++;
  }
  return out.join('\n');
};

const captureUiXml = async () => {
  const dumpOut = await adbShell('uiautomator dump /sdcard/window_dump.xml', 40000);
  if (!/dumped to/i.test(dumpOut)) throw new Error(`uiautomator dump failed: ${dumpOut.trim().slice(0, 200)}`);
  const { stdout: xml } = await execCmd(ADB_EXEC, ['exec-out', 'cat', '/sdcard/window_dump.xml'], { timeout: 15000 });
  if (!xml.includes('<hierarchy')) throw new Error('empty dump — the window did not return a hierarchy, retry');
  return xml;
};

// wait_for: extracting an attribute from a tree line. text/desc are wrapped in JSON quotes
// (with escaping), rid is bare; we extract text/desc taking escaping into account.
const unquoteAttr = (line, prefix) => {
  const i = line.indexOf(prefix);
  if (i === -1) return '';
  const rest = line.slice(i + prefix.length);
  let out = '';
  let esc = false;
  for (const ch of rest) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; out += ch; continue; }
    if (ch === '"') break;
    out += ch;
  }
  return out.toLowerCase();
};

const treeLineHit = (line, matchers) => {
  // the prefix must include the opening JSON quote — unquoteAttr stops at the first quote
  if (matchers.text && !unquoteAttr(line, 'text="').includes(matchers.text.toLowerCase())) return false;
  if (matchers.desc && !unquoteAttr(line, 'desc="').includes(matchers.desc.toLowerCase())) return false;
  if (matchers.rid && !line.toLowerCase().includes(matchers.rid.toLowerCase())) return false;
  return true;
};

mcp.registerTool(
  'ui_dump',
  {
    title: 'Dump UI hierarchy',
    description: 'Tree of visible UI elements (uiautomator dump): class, text/content-desc, resource-id, clickable/scrollable, bounds + element center in native pixels — exact coordinates for tap/swipe without guessing from a screenshot. The full XML is saved to shots/uidump-*.xml.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const xml = await captureUiXml();
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const xmlPath = path.join(CAPTURES_DIR, `uidump-${stamp}.xml`);
      fs.writeFileSync(xmlPath, xml);
      pruneCaptures();
      const tree = renderUiTree(xml);
      const MAX = 60000;
      const body = tree.length > MAX ? `${tree.slice(0, MAX)}\n[truncated — full XML: ${xmlPath}]` : tree;
      return replyText(`UI tree (center(x,y) = coordinates for tap):\n${body}\n\nFull XML: ${xmlPath}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'wait_for',
  {
    title: 'Wait for UI element',
    description: 'Wait for a visible UI element to appear — polling of the uiautomator tree on the server side (a replacement for dozens of ui_dump+sleep calls from the agent). Criteria: text/rid/desc as substrings (case-insensitive), specify at least one, conditions are combined with AND. Returns the found elements with center(x,y) ready for tap. Supports cancellation and progress.',
    inputSchema: {
      text: z.string().min(1).optional().describe('Substring in the element text'),
      rid: z.string().min(1).optional().describe('Substring in resource-id'),
      desc: z.string().min(1).optional().describe('Substring in content-desc'),
      timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Wait timeout, ms (default 20000)'),
      interval_ms: z.number().int().min(500).max(10000).optional().describe('Polling interval, ms (default 1500; the dump itself takes 1-2s)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ text, rid, desc, timeout_ms = 20000, interval_ms = 1500 }, extra) => {
    try {
      if (!text && !rid && !desc) return replyError(new Error('specify at least one criterion: text, rid or desc'));
      const matchers = { text, rid, desc };
      const t0 = Date.now();
      let lastSent = -1;
      for (;;) {
        assertNotAborted(extra, 'wait_for');
        const elapsed = Date.now() - t0;
        if (elapsed >= timeout_ms) break;
        try {
          // the dump is disrupted by animations ("could not get idle state") — we do not break the wait
          const lines = renderUiTree(await captureUiXml()).split('\n').filter((l) => l.trim());
          const found = lines.filter((l) => treeLineHit(l, matchers));
          if (found.length) {
            return replyText([
              `Found in ${Math.round((Date.now() - t0) / 1000)}s (${found.length} matches, first 5):`,
              ...found.slice(0, 5),
              'center(x,y) — ready coordinates for tap.',
            ].join('\n'));
          }
        } catch { /* we will retry on the next iteration */ }
        const sec = Math.round(elapsed / 1000);
        if (sec - lastSent >= 5) {
          lastSent = sec;
          await emitProgress(extra, sec, Math.round(timeout_ms / 1000), 'waiting for a UI element');
        }
        await pause(interval_ms);
      }
      return replyError(new Error(`the element did not appear within ${Math.round(timeout_ms / 1000)}s — take a current tree (ui_dump) and refine the criteria`));
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'device_state',
  {
    title: 'Device state',
    description: 'Full state: process(es), boot, Android/API version, screen, stream resolution, foreground app, input mode.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      summary: z.string(),
      processes: z.object({
        bridge: z.object({ pid: z.number() }).nullable(),
        emulator: z.object({ pid: z.number() }).nullable(),
      }),
      bridge: z.object({
        up: z.boolean(),
        host: z.string().optional(),
        port: z.number().optional(),
        inputEnabled: z.boolean().optional(),
        controlled: z.boolean().optional(),
        resolution: z.string().optional(),
      }),
      adb: z.object({
        device: z.string().nullable().optional(),
        booted: z.boolean().optional(),
        androidVersion: z.string().nullable().optional(),
        sdk: z.string().nullable().optional(),
        screen: z.string().nullable().optional(),
        foregroundApp: z.string().nullable().optional(),
        density: z.string().optional(),
        error: z.string().optional(),
      }),
    },
  },
  async () => {
    try {
      const s = await collectStatus();
      const summaryLines = [renderStatus(s)];
      const adbOut = { ...s.adb };
      if (s.adb.booted) {
        adbOut.density = (await adbShell('wm density', 8000)).trim().split(': ').pop();
        summaryLines.push(`density: ${adbOut.density}`);
      }
      const summary = summaryLines.join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { summary, processes: s.processes, bridge: s.bridge, adb: adbOut },
      };
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'access_start',
  {
    title: 'Enable LAN access',
    description: 'Restart the bridge listening on all interfaces (0.0.0.0) and return a URL for the developer: live video + input in the browser (input — after set_dev_input(true)). Access is protected by an access token (generated at bridge start, passed in the URL). The input mode after the restart is reset to "observation".',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const info = readRelayState();
      const wasUp = info || await relayJson('/state').then(() => true).catch(() => false);
      if (wasUp) await cycleRelay('0.0.0.0');
      else await bootRelay('0.0.0.0');

      const accessToken = readRelayState()?.accessToken;
      const urls = [];
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
          if (i.family === 'IPv4' && !i.internal) urls.push(`https://${i.address}:${RELAY_PORT}/${accessToken ? `?token=${accessToken}` : ''}`);
        }
      }
      return replyText([
        'Access enabled. Open it in the developer browser:',
        ...(urls.length ? urls.map((u) => `- ${u}`) : ['- (LAN IPv4 not found — check the network)']),
        'HTTP and WS require an access token (it is already in the URL). The input control-mode token is separate and does not end up in the URL.',
        'Browser input is disabled — allow it: set_dev_input(true).',
      ].join('\n'));
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'access_stop',
  {
    title: 'Disable LAN access',
    description: 'Return the bridge to loopback: access from the developer network is cut off (the stream will break). MCP continues to operate the device.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      await cycleRelay('127.0.0.1');
      return replyText(`Access closed: the bridge listens on 127.0.0.1:${RELAY_PORT} (local only).`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'bridge_restart',
  {
    title: 'Restart the bridge',
    description: 'Restart the relay/stream process (web/server.js) WITHOUT touching the emulator: applies bridge code changes and recovers a hung or dead bridge (boots one if none is running). Preserves the host binding (loopback / 0.0.0.0) and the developer-input mode; the access token is regenerated — hand the new URL from the reply to the developer. The browser video stream reconnects on page reload.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (_, extra) => {
    try {
      assertNotAborted(extra, 'bridge_restart');
      const prev = readRelayState();
      let inputWasOn = false;
      try { inputWasOn = !!(await relayJson('/state')).inputEnabled; } catch {}
      await cycleRelay(prev?.host || '127.0.0.1');
      const state = await relayJson('/state');
      let inputNote = 'browser input: disabled (default) — allow it: set_dev_input(true)';
      if (inputWasOn) {
        await relayWrite({ type: 'input-mode', enabled: true, token: readRelayState().token });
        await pause(150);
        inputNote = 'browser input: restored to ALLOWED';
      }
      const accessToken = readRelayState()?.accessToken;
      const urls = [];
      if (state.host === '0.0.0.0') {
        for (const ifaces of Object.values(os.networkInterfaces())) {
          for (const i of ifaces || []) {
            if (i.family === 'IPv4' && !i.internal) urls.push(`https://${i.address}:${RELAY_PORT}/${accessToken ? `?token=${accessToken}` : ''}`);
          }
        }
      }
      return replyText([
        `Bridge restarted (pid ${fetchPid('bridge')}), listening on ${state.host}:${RELAY_PORT}.`,
        ...(urls.length ? ['New developer URL (token regenerated):', ...urls.map((u) => `- ${u}`)] : []),
        inputNote,
      ].join('\n'));
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'set_resolution',
  {
    title: 'Change stream resolution',
    description: 'Change the stream resolution (ABR ladder: 324x720, 486x1080, 1004x2231). The 1004x2231 tier is not in the ABR ladder — an auto-downgrade will return 486x1080. list=true — show the available options and the current one.',
    inputSchema: {
      name: z.string().optional().describe('Resolution: 324x720 | 486x1080 | 1004x2231. Optional — if not set, the list is shown.'),
      list: z.boolean().optional().describe('true — show the list of available and the current resolution'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ name, list }) => {
    try {
      if (list || !name) {
        const st = await relayJson('/resolutions');
        return replyText(
          `Current: ${st.current}\n` +
          `Available: ${st.options.join(', ')}\n\n` +
          'ABR ladder: 324x720 → 486x1080. The 1004x2231 tier — manual only (not part of auto-switching).',
        );
      }
      const info = readRelayState();
      const auth = info?.accessToken ? `&token=${encodeURIComponent(info.accessToken)}` : '';
      const res = await new Promise((resolve, reject) => {
        const req = https.request(
          { host: '127.0.0.1', port: RELAY_PORT, path: `/resolution?name=${encodeURIComponent(name)}${auth}`, method: 'POST', timeout: 8000, rejectUnauthorized: false },
          resolve,
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      let body = '';
      res.on('data', (c) => { body += c; });
      await new Promise((r) => res.on('end', r));
      const parsed = JSON.parse(body);
      if (res.statusCode !== 200 || !parsed.ok) {
        throw new Error(`unknown resolution '${name}' — available: see set_resolution({list:true})`);
      }
      const st = await relayJson('/state');
      return replyText(`Resolution: ${st.resolution}${name === '1004x2231' ? '\nNote: ABR may switch back to 486x1080.' : ''}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'reboot_emulator',
  {
    title: 'Reboot Android emulator',
    description: 'Reboot the device (adb reboot). App state is preserved (not a cold boot). Waits for boot ~120s (supports cancellation and progress). The bridge and the stream are restored automatically.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (_, extra) => {
    try {
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      await execCmd(ADB_EXEC, ['-s', serial, 'reboot'], { timeout: 15000 });
      // We wait: the device disappears from adb (reboot), then returns
      const t0 = Date.now();
      let seenOffline = false;
      let lastSent = -1;
      while (Date.now() - t0 < BOOT_DEADLINE_MS) {
        assertNotAborted(extra, 'rebooting the emulator');
        const sec = Math.round((Date.now() - t0) / 1000);
        if (sec - lastSent >= 5) { lastSent = sec; await emitProgress(extra, sec, Math.round(BOOT_DEADLINE_MS / 1000), 'rebooting Android'); }
        const s = await primaryEmuSerial();
        if (!s) { seenOffline = true; }
        else if (seenOffline && (await deviceBooted())) break;
        await pause(2000);
      }
      if (!(await deviceBooted())) throw new Error(`emulator did not boot within ${BOOT_DEADLINE_MS / 1000}s`);
      const ver = (await adbShell('getprop ro.build.version.release', 8000)).trim();
      const fg = await frontmostApp();
      return replyText(`Reboot completed: Android ${ver}${fg ? `, foreground: ${fg}` : ''}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'adb_restart',
  {
    title: 'Restart adb server',
    description: 'Restart the local adb server (adb kill-server + adb start-server): helps when adb is wedged — the device disappeared from `adb devices`, is stuck in offline/unauthorized, or port 5037 is held by a stale server. Connections and `adb reverse` tunnels drop for a few seconds; the bridge detects the loss and restarts its streams automatically once the device is back. The emulator, device state and files are NOT affected (this is not a device reboot — see reboot_emulator).',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (_, extra) => {
    try {
      assertNotAborted(extra, 'adb_restart');
      await execCmd(ADB_EXEC, ['kill-server'], { timeout: 15000 });
      await pause(500);
      await execCmd(ADB_EXEC, ['start-server'], { timeout: 20000 });
      // the emulator keeps running — the serial returns within seconds after the server restart
      const t0 = Date.now();
      let serial = null;
      while (Date.now() - t0 < 30000) {
        assertNotAborted(extra, 'waiting for the device in adb');
        serial = await primaryEmuSerial();
        if (serial) break;
        await pause(1000);
      }
      const devs = (await adbDeviceList()).map((d) => `${d.serial}(${d.state})`);
      const booted = serial ? await deviceBooted() : false;
      return replyText([
        'adb server restarted.',
        serial
          ? `Device back: ${serial}, boot_completed=${booted ? 1 : 0}.`
          : 'The emulator did NOT reappear in adb within 30s — check env_status (the emulator process may have died).',
        `adb devices: ${devs.length ? devs.join(', ') : 'empty'}`,
        'The bridge restores the stream automatically within seconds; if the video did not return — reload the browser page.',
      ].join('\n'));
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'set_dev_input',
  {
    title: 'Grant/revoke developer input',
    description: 'Allow (enabled=true) or disallow (false) input from the developer browser. Works only when the bridge is controlled by MCP (has a token). A developer request "let me poke around" → set_dev_input(true); "give it back" → set_dev_input(false).',
    inputSchema: {
      enabled: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ enabled }) => {
    try {
      assertRelayOwned();
      await relayWrite({ type: 'input-mode', enabled, token: readRelayState().token });
      await pause(150);
      const st = await relayJson('/state');
      return replyText(`Browser input: ${st.inputEnabled ? 'ALLOWED' : 'disallowed (observation)'}`);
    } catch (e) { return replyError(e); }
  },
);

// --- shell / emulator console / diagnostics ---

mcp.registerTool(
  'shell',
  {
    title: 'Run adb shell command',
    description: 'Run an arbitrary command on the device via adb shell (e.g. dumpsys battery, getprop, settings put/get, pm, ps, netstat, screenrecord). Prefer dedicated tools (tap, screenshot, logcat, …) when they cover the task; use shell for everything they miss.',
    inputSchema: {
      cmd: z.string().min(1).max(2000).describe('Shell command, e.g. "dumpsys battery"'),
      timeout: z.number().int().min(1000).max(120000).optional().describe('Timeout, ms (default 20000)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ cmd, timeout }, extra) => {
    try {
      assertNotAborted(extra, 'shell');
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      // adb propagates the remote exit code; a command may fail with no output at all (e.g. "false")
      const { stdout, stderr, code } = await execCmd(ADB_EXEC, ['-s', serial, 'shell', cmd], { timeout: timeout ?? 20000 })
        .catch((e) => ({ stdout: '', stderr: String(e.message || e), code: typeof e.code === 'number' ? e.code : 1 }));
      const cap = (s) => s.length > 50000 ? s.slice(0, 50000) + `\n… truncated (${s.length - 50000} more chars)` : s;
      let text = `exit=${code}\n--- stdout ---\n${cap(stdout)}`;
      if (stderr.trim()) text += `\n--- stderr ---\n${cap(stderr)}`;
      return replyText(text);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'emu',
  {
    title: 'Run emulator console command',
    description: 'Run a command on the emulator console (adb emu): battery emulation ("power acu off", "power capacity 50"), network ("network speed edge", "network delay umts"), GSM voice/data ("gsm data home"), incoming call/SMS ("gsm call 555", "sms send 555 hi"), GPS ("geo fix 37.6 55.7"), rotate. Requires a running emulator.',
    inputSchema: {
      cmd: z.string().min(1).max(500).describe('Console command, e.g. "power capacity 50"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ cmd }, extra) => {
    try {
      assertNotAborted(extra, 'emu');
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      const args = cmd.trim().split(/\s+/);
      const { stdout, stderr, code } = await execCmd(ADB_EXEC, ['-s', serial, 'emu', ...args], { timeout: 15000 });
      return replyText(`exit=${code}\n${[stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n') || '(no output)'}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'bugreport',
  {
    title: 'Collect Android bugreport',
    description: 'Collect a full Android bug report (adb bugreport → zip in shots/): device state, logs, dumpsys for all services. Takes 1–3 minutes. Use for deep diagnostics when logcat/shell are not enough. Returns the local zip path.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (_, extra) => {
    try {
      assertNotAborted(extra, 'bugreport');
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      const out = path.join(CAPTURES_DIR, `bugreport-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
      await execCmd(ADB_EXEC, ['-s', serial, 'bugreport', out], { timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (!size) throw new Error('bugreport failed — no zip produced');
      return replyText(`bugreport saved: ${out} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'app_uninstall',
  {
    title: 'Uninstall an app',
    description: 'Uninstall a third-party app from the device (adb uninstall). System apps cannot be removed this way. Returns adb output ("Success" on success).',
    inputSchema: {
      package: z.string().regex(/^[\w.]+$/, 'package name like com.example.app'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ package: pkg }, extra) => {
    try {
      assertNotAborted(extra, 'app_uninstall');
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      const { stdout, stderr } = await execCmd(ADB_EXEC, ['-s', serial, 'uninstall', pkg], { timeout: 30000 });
      return replyText([stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '(no output)');
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'app_clear_data',
  {
    title: 'Clear app data',
    description: 'Reset an app to its first-launch state (pm clear): wipes data, cache, logins and granted runtime permissions. Standard test hygiene between runs. Returns adb output ("Success" on success).',
    inputSchema: {
      package: z.string().regex(/^[\w.]+$/, 'package name like com.example.app'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ package: pkg }, extra) => {
    try {
      assertNotAborted(extra, 'app_clear_data');
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      const { stdout, stderr } = await execCmd(ADB_EXEC, ['-s', serial, 'shell', `pm clear ${pkg}`], { timeout: 30000 });
      return replyText([stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '(no output)');
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'bridge_logs',
  {
    title: 'Read host-side logs',
    description: 'Read the tail of host-side log files from the state dir: file="bridge" — the relay/stream process (WS clients, scrcpy hosts, input errors); file="emulator" — the qemu console log; file="mcp" — this MCP server log. For on-device logs use logcat instead.',
    inputSchema: {
      file: z.enum(['bridge', 'emulator', 'mcp']).optional().describe('Which log to read (default bridge)'),
      lines: z.number().int().min(1).max(400).optional().describe('Last N lines (default 80)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ file, lines }) => {
    try {
      const p = path.join(dataDir(), `${file || 'bridge'}.log`);
      if (!fs.existsSync(p)) return replyText(`${p} does not exist yet.`);
      const content = fs.readFileSync(p, 'utf8');
      const all = content.split('\n');
      const tail = all.slice(-(lines || 80)).join('\n');
      return replyText(`${p} (${all.length} lines total, showing last ${tail.split('\n').length}):\n${tail}`);
    } catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'pinch',
  {
    title: 'Pinch-zoom gesture (two fingers)',
    description: 'Two-finger pinch at a point in native pixels: dist is the final separation between the fingers (px). dist > 200 — zoom in (spread), dist < 200 — zoom out (squeeze). Requires the bridge control channel (scrcpy) — no adb fallback.',
    inputSchema: {
      x: z.number().int().min(0).max(1080), y: z.number().int().min(0).max(2400),
      dist: z.number().int().min(50).max(2400).optional().describe('Final finger separation, px (default 400 = zoom in)'),
      ms: z.number().int().min(100).max(5000).optional().describe('Duration, ms (default 500)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ x, y, dist, ms }) => {
    try { await relayWrite({ type: 'pinch', x, y, dist, ms }); return replyText(`pinch at ${x},${y} → dist=${dist ?? 400} over ${ms ?? 500}ms`); }
    catch (e) { return replyError(e); }
  },
);

mcp.registerTool(
  'set_orientation',
  {
    title: 'Lock screen orientation',
    description: 'Lock the device to portrait or landscape (settings put system user_rotation with accelerometer_rotation off), or restore auto-rotation (lock=false). Affects the whole device, not just the foreground app.',
    inputSchema: {
      orientation: z.enum(['portrait', 'landscape']),
      lock: z.boolean().optional().describe('false = restore auto-rotation (default true = lock to orientation)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ orientation, lock = true }) => {
    try {
      const serial = await primaryEmuSerial();
      if (!serial) throw new Error('emulator not found — call env_start');
      if (!lock) {
        await adbShell('settings put system accelerometer_rotation 1', 8000);
        return replyText('auto-rotation restored');
      }
      const rot = orientation === 'landscape' ? 1 : 0;
      await adbShell('settings put system accelerometer_rotation 0', 8000);
      await adbShell(`settings put system user_rotation ${rot}`, 8000);
      return replyText(`locked to ${orientation} (user_rotation=${rot})`);
    } catch (e) { return replyError(e); }
  },
);

// --- MCP resources (state, screenshots) ---

mcp.registerResource(
  'state',
  'droidlab://state',
  { title: 'Emulator state', description: 'Current state of the environment in JSON', mimeType: 'application/json', annotations: { audience: ['assistant'], priority: 0.8 } },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(await collectStatus(), null, 2),
    }],
  }),
);

mcp.registerResource(
  'latest-shot',
  'droidlab://shots/latest',
  { title: 'Latest screenshot', description: 'The latest full PNG screenshot from shots/', annotations: { audience: ['user', 'assistant'], priority: 0.5 } },
  async (uri) => {
    const shots = ownedCaptures().filter((f) => f.endsWith('.png'));
    if (!shots.length) {
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'There are no screenshots yet — call screenshot.' }] };
    }
    const p = path.join(CAPTURES_DIR, shots[0]);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'image/png',
        blob: fs.readFileSync(p).toString('base64'),
      }],
    };
  },
);

const CAPTURE_NAME_RE = /^[\w.-]+$/; // no / and .. — a strict file name from shots/

mcp.registerResource(
  'shot',
  new ResourceTemplate('droidlab://shots/{name}', {
    list: async () => ({
      resources: ownedCaptures().slice(0, 20).map((f) => {
        try {
          const st = fs.statSync(path.join(CAPTURES_DIR, f));
          return {
            uri: `droidlab://shots/${f}`,
            name: f,
            mimeType: f.endsWith('.xml') ? 'application/xml' : 'image/png',
            size: st.size,
            annotations: { lastModified: new Date(st.mtime).toISOString() },
          };
        } catch {
          return { uri: `droidlab://shots/${f}`, name: f, mimeType: f.endsWith('.xml') ? 'application/xml' : 'image/png' };
        }
      }),
    }),
  }),
  { title: 'Screenshot / UI-dump by name', description: 'A file from shots/ by name (a PNG screenshot or an XML ui-dump); the list is via resources/list', annotations: { audience: ['user', 'assistant'], priority: 0.4 } },
  async (uri, { name }) => {
    if (typeof name !== 'string' || !CAPTURE_NAME_RE.test(name)) throw new Error(`invalid file name: ${JSON.stringify(name)}`);
    const p = path.join(CAPTURES_DIR, name);
    if (!fs.existsSync(p)) throw new Error(`shots/ has no file ${name} — see resources/list`);
    const buf = fs.readFileSync(p);
    if (name.endsWith('.xml')) {
      return { contents: [{ uri: uri.href, mimeType: 'application/xml', text: buf.toString('utf8') }] };
    }
    return { contents: [{ uri: uri.href, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', blob: buf.toString('base64') }] };
  },
);

// --- entry point ---

const entrypoint = async () => {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(`[droidlab-mcp] ready (bridge port ${RELAY_PORT}, state: ${dataDir()})`);
};

entrypoint().catch((e) => {
  console.error('[droidlab-mcp] fatal:', e);
  process.exit(1);
});
