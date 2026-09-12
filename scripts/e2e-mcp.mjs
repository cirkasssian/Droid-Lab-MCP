#!/usr/bin/env node
// E2E: starts the MCP over stdio and runs the full cycle on a live emulator.
// If the emulator was already running before the test — lifecycle steps are skipped and it is not stopped.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8090;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function bridgeInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`, 'droidlab', 'bridge.json'), 'utf8'));
  } catch { return null; }
}

function httpState(withToken = true) {
  return new Promise((resolve, reject) => {
    const info = withToken ? bridgeInfo() : null;
    const q = info?.accessToken ? `?token=${encodeURIComponent(info.accessToken)}` : '';
    const req = http.get({ host: '127.0.0.1', port: PORT, path: `/state${q}`, timeout: 4000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function adbBin() {
  const cand = [
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    path.join(process.env.HOME, 'Android', 'Sdk', 'platform-tools', 'adb'),
  ].filter(Boolean);
  return cand.find((p) => fs.existsSync(p)) || 'adb';
}

function adbDevicesRaw() {
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(adbBin(), ['devices'], { timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout));
    });
  });
}

function newestShot() {
  const dir = path.join(ROOT, 'shots');
  const pngs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
  return pngs.length ? path.join(dir, pngs[pngs.length - 1]) : null;
}

async function main() {
  const preDevs = await adbDevicesRaw();
  const emulatorWasRunning = /emulator-\d+\s+device/.test(preDevs);
  console.log(`pre-check: emulator ${emulatorWasRunning ? 'ALREADY RUNNING (lifecycle steps will be skipped)' : 'not running (full cycle)'}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mcp.mjs')],
    stderr: 'inherit',
  });
  const client = new Client({ name: 'e2e-client', version: '0.0.1' });
  await client.connect(transport);
  check('mcp: initialize', true);

  const tools = await client.listTools();
  const expected = ['env_start', 'env_stop', 'env_status', 'env_list', 'reboot_emulator', 'adb_restart',
    'system_images_list', 'system_image_install', 'avd_create',
    'screenshot', 'tap', 'swipe', 'scroll', 'key', 'text', 'clipboard_get', 'clipboard_set',
    'install_apk', 'push_file', 'pull_file', 'open_app', 'close_app', 'app_list', 'ui_dump',
    'wait_for', 'deep_link', 'app_permission',
    'logcat', 'device_state', 'access_start', 'access_stop', 'set_dev_input', 'set_resolution'];
  const missing = expected.filter((t) => !tools.tools.some((x) => x.name === t));
  check('mcp: tools/list (33 tools)', missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : 'all present');

  // --- annotations (MCP standard: hints for client UIs) ---
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  check('annotations: env_status readOnly', byName.env_status?.annotations?.readOnlyHint === true);
  check('annotations: env_stop destructive', byName.env_stop?.annotations?.destructiveHint === true);
  const unannotated = tools.tools.filter((t) => !t.annotations || t.annotations.readOnlyHint === undefined);
  check('annotations: all tools have hints', unannotated.length === 0, unannotated.map((t) => t.name).join(',') || 'ok');

  // --- structuredContent (MPC 2025-06-18) ---
  const stEnv = await client.callTool({ name: 'env_status', arguments: {} });
  check('env_status: structuredContent', !!stEnv.structuredContent?.processes && !!stEnv.structuredContent?.adb,
    stEnv.structuredContent ? 'processes+adb ok' : 'no structuredContent');

  // --- lifecycle ---
  if (!emulatorWasRunning) {
    const r = await client.callTool({ name: 'env_start', arguments: {} });
    const out = (r.content || []).map((c) => c.text || '').join('\n');
    check('env_start: booted', !r.isError && /started|already running/.test(out), out.split('\n').slice(0, 2).join(' | '));
  } else {
    // external/unknown emulator: take its AVD and ask env_start to adopt it (idempotent)
    const serial = preDevs.match(/(emulator-\d+)\s+device/)?.[1];
    const avdName = await new Promise((resolve) => {
      if (!serial) return resolve(null);
      import('node:child_process').then(({ execFile }) =>
        execFile(adbBin(), ['-s', serial, 'emu', 'avd', 'name'], { timeout: 10000 }, (err, stdout) =>
          resolve(err ? null : (stdout.trim().split('\n')[0].trim() || null))));
    });
    const r = await client.callTool({ name: 'env_start', arguments: avdName ? { avd: avdName } : {} });
    const out = (r.content || []).map((c) => c.text || '').join('\n');
    check('env_start: adopted pre-running emulator', !r.isError && /external|already running|started|emulator/.test(out), `${avdName || '?'}: ${out.split('\n').slice(0, 2).join(' | ')}`);
  }

  // --- screenshot ---
  const before = newestShot();
  const shot = await client.callTool({ name: 'screenshot', arguments: {} });
  const img = (shot.content || []).find((c) => c.type === 'image');
  const shotText = (shot.content || []).find((c) => c.type === 'text')?.text || '';
  const afterShot = newestShot();
  check('screenshot: image content returned', !!img && !!img.data, shotText.slice(0, 80));
  check('screenshot: full PNG saved to shots/', !!afterShot && afterShot !== before, afterShot || 'none');
  if (afterShot) {
    const kb = fs.statSync(afterShot).size;
    check('screenshot: PNG is full-res size (>300KB typical)', kb > 100000, `${kb} bytes`);
  }

  // --- tap changes the screen: deterministically — via a clickable element from ui_dump (after open_app) ---
  async function tapByUiDump() {
    await client.callTool({ name: 'screenshot', arguments: {} });
    const before = newestShot();
    const h1 = before ? crypto.createHash('md5').update(fs.readFileSync(before)).digest('hex') : null;
    const uidTap = await client.callTool({ name: 'ui_dump', arguments: {} });
    const m = ((uidTap.content || []).map((c) => c.text || '').join('\n')).match(/\[click\] center\((\d+),(\d+)\)/);
    if (!m) return check('tap: screen changed (input works)', false, 'ui_dump found no clickable element');
    const tr = await client.callTool({ name: 'tap', arguments: { x: +m[1], y: +m[2] } });
    await new Promise((r) => setTimeout(r, 1500));
    await client.callTool({ name: 'screenshot', arguments: {} });
    const after = newestShot();
    const h2 = after ? crypto.createHash('md5').update(fs.readFileSync(after)).digest('hex') : null;
    check('tap: screen changed (input works)', !tr.isError && before !== after && h1 !== h2, `tap ${m[1]},${m[2]}: ${h1?.slice(0, 8)} → ${h2?.slice(0, 8)}`);
  }

  // --- keyboard ---
  const key = await client.callTool({ name: 'key', arguments: { key: 'home' } });
  check('key: named key accepted', !key.isError, (key.content?.[0]?.text || '').slice(0, 60));

  // --- clipboard ---
  // scrcpy on the device suppresses re-sending UNCHANGED text:
  // after set(X) any get(X) is not sent by the device — this is documented
  // behavior (see the clipboard_get description). We check: set is accepted, get responds.
  const secret = `e2e-${crypto.randomBytes(6).toString('hex')}`;
  const setRes = await client.callTool({ name: 'clipboard_set', arguments: { text: secret } });
  check('clipboard_set: accepted by the control channel', !setRes.isError, (setRes.content?.[0]?.text || '').slice(0, 60));
  await new Promise((r) => setTimeout(r, 400));
  const clip = await client.callTool({ name: 'clipboard_get', arguments: {} });
  const clipText = (clip.content?.[0]?.text || '');
  check('clipboard_get: response (text or documented suppression)',
    clipText.length > 0 && (clipText.includes(secret) || /has not changed|not (changed|been changed)/.test(clipText)), clipText.slice(0, 80));

  // --- open_app ---
  const app = await client.callTool({ name: 'open_app', arguments: { package: 'com.android.settings' } });
  check('open_app: settings launched', !app.isError, (app.content?.[0]?.text || '').slice(0, 80));

  await tapByUiDump();

  // --- device_state ---
  const st = await client.callTool({ name: 'device_state', arguments: {} });
  check('device_state: boot+version+screen', /Android \d/.test(st.content?.[0]?.text || '') && /screen/.test(st.content?.[0]?.text || ''), (st.content?.[0]?.text || '').split('\n').slice(-2).join(' | '));
  check('device_state: structuredContent', !!st.structuredContent?.adb?.booted, 'ok');

  // --- app_list / ui_dump / close_app (settings was opened by the previous step) ---
  const apps = await client.callTool({ name: 'app_list', arguments: {} });
  const appsText = apps.content?.[0]?.text || '';
  check('app_list: third-party packages', !apps.isError && /packages \(\d+\)/.test(appsText) && appsText.trim().split('\n').length > 1, appsText.split('\n')[0]);
  const appsAll = await client.callTool({ name: 'app_list', arguments: { system: true } });
  const appsAllText = appsAll.content?.[0]?.text || '';
  check('app_list(system): system included (settings)', !appsAll.isError && /com\.android\.settings/.test(appsAllText), appsAllText.split('\n')[0]);

  const uid = await client.callTool({ name: 'ui_dump', arguments: {} });
  const uidText = uid.content?.[0]?.text || '';
  check('ui_dump: tree with centers', !uid.isError && /center\(\d+,\d+\)/.test(uidText), uidText.split('\n')[1]?.slice(0, 80) || uidText.slice(0, 80));
  check('ui_dump: xml saved to shots/', /uidump-.*\.xml/.test(uidText));

  const closed = await client.callTool({ name: 'close_app', arguments: { package: 'com.android.settings' } });
  check('close_app: force-stopped', !closed.isError, (closed.content?.[0]?.text || '').slice(0, 80));

  // --- logcat ---
  const log = await client.callTool({ name: 'logcat', arguments: { lines: 50 } });
  const logText = log.content?.[0]?.text || '';
  check('logcat: lines returned', !log.isError && /\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(logText), logText.split('\n')[1]?.slice(0, 80) || logText.slice(0, 80));

  // --- push/pull roundtrip ---
  const tmp = path.join(os.tmpdir(), `e2e-push-${crypto.randomBytes(4).toString('hex')}.txt`);
  const payload = `e2e roundtrip ${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmp, payload);
  await client.callTool({ name: 'push_file', arguments: { src: tmp, dst: '/sdcard/Download/e2e-roundtrip.txt' } });
  const pulled = await client.callTool({ name: 'pull_file', arguments: { src: '/sdcard/Download/e2e-roundtrip.txt' } });
  const pulledPath = (pulled.content?.[0]?.text || '').match(/Saved: (\S+)/)?.[1];
  const pulledContent = pulledPath && fs.existsSync(pulledPath) ? fs.readFileSync(pulledPath, 'utf8') : '';
  check('push+pull: roundtrip content matches', !pulled.isError && pulledContent.trim() === payload, pulledPath || 'no path');

  // --- set_resolution (list mode) ---
  const resList = await client.callTool({ name: 'set_resolution', arguments: { list: true } });
  check('set_resolution: list mode', !resList.isError && /486x1080/.test(resList.content?.[0]?.text || ''));

  // --- access + input-mode ---
  const acc = await client.callTool({ name: 'access_start', arguments: {} });
  const accText = acc.content?.[0]?.text || '';
  const s1 = await httpState();
  check('access_start: bridge on 0.0.0.0 + URL', !acc.isError && s1.body?.host === '0.0.0.0' && /http:\/\/\d+\./.test(accText), `host=${s1.body?.host}`);

  // access is token-protected: without a token it is 401; the URL from access_start contains ?token=
  const noAuth = await httpState(false);
  check('bridge auth: /state without token → 401', noAuth.code === 401, `code=${noAuth.code}`);
  check('bridge auth: access_start URL contains token', /\?token=/.test(accText));

  // input-mode flip by controller
  await client.callTool({ name: 'set_dev_input', arguments: { enabled: true } });
  const s2 = await httpState();
  check('set_dev_input(true): server state enabled', s2.body?.inputEnabled === true);

  // non-controller client must NOT flip and its input is dropped while disabled
  await client.callTool({ name: 'set_dev_input', arguments: { enabled: false } });
  const s3 = await httpState();
  const rogue = await new Promise((resolve) => {
    const info = bridgeInfo();
    const wsQuery = info?.accessToken ? `?token=${encodeURIComponent(info.accessToken)}` : '';
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/${wsQuery}`);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'init', codec: 'none', token: 'WRONG' })));
    sock.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'input-mode') resolve(m.enabled); });
    sock.on('error', () => resolve('ws-error'));
    setTimeout(() => {
      sock.send(JSON.stringify({ type: 'input-mode', enabled: true, token: info.token })); // stolen? no — an incorrect token is its own
      setTimeout(() => { sock.close(); resolve(null); }, 500);
    }, 400);
  });
  const s4 = await httpState();
  check('rogue client: got observation mode, cannot flip', rogue === false && s4.body?.inputEnabled === false, `mode=${rogue}, state=${s4.body?.inputEnabled}`);

  await client.callTool({ name: 'access_stop', arguments: {} });
  const s5 = await httpState();
  check('access_stop: back to loopback', s5.body?.host === '127.0.0.1', `host=${s5.body?.host}`);

  // --- resources ---
  try {
    const res = await client.readResource({ uri: 'droidlab://state' });
    check('resource: droidlab://state', !!res.contents?.[0]?.text && /processes/.test(res.contents[0].text));
  } catch (e) { check('resource: droidlab://state', false, e.message); }

  // --- resource template: shots/{name} ---
  try {
    const shotName = path.basename(newestShot() || '');
    const res2 = await client.readResource({ uri: `droidlab://shots/${shotName}` });
    check('resource template: shots/{name} (png blob)', !!res2.contents?.[0]?.blob, shotName);
  } catch (e) { check('resource template: shots/{name} (png blob)', false, e.message); }

  // --- adb_restart: adb server restart; the emulator keeps running and must come back ---
  const adbR = await client.callTool({ name: 'adb_restart', arguments: {} });
  const adbRText = (adbR.content || []).map((c) => c.text || '').join('\n');
  check('adb_restart: device back after server restart', !adbR.isError && /Device back: emulator-/.test(adbRText), adbRText.split('\n').slice(1, 2).join(' | '));
  const stAfterAdb = await client.callTool({ name: 'env_status', arguments: {} });
  const stAfterAdbText = stAfterAdb.content?.[0]?.text || '';
  check('adb_restart: env_status healthy afterwards', !stAfterAdb.isError && /device: emulator-/.test(stAfterAdbText), stAfterAdbText.split('\n').find((l) => l.startsWith('device:')) || '');

  // --- lifecycle down (only if we started it) ---
  if (!emulatorWasRunning) {
    const stop = await client.callTool({ name: 'env_stop', arguments: {} });
    check('env_stop: stopped', !stop.isError, (stop.content?.[0]?.text || '').split('\n').slice(0, 4).join(' | '));
    const postDevs = await adbDevicesRaw();
    check('env_stop: emulator gone from adb', !/emulator-\d+\s+device/.test(postDevs));
  } else {
    console.log('SKIP env_stop — the emulator was running before e2e, leaving it as-is');
  }

  await client.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('e2e fatal:', e); process.exit(2); });
