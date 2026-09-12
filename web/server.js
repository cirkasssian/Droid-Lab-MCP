const { exec, spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8090', 10);
const HOST = process.env.HOST || '0.0.0.0';

// --- cross-platform resolution of external binaries ---
function sdkBin(rel) {
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
  return exe; // fallback: rely on PATH
}

function scrcpyHomeBin(name) {
  const dir = path.join(os.homedir(), 'bin', 'scrcpy');
  try {
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e, name);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

const ADB = process.env.ADB || sdkBin('platform-tools/adb');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SCRCPY = process.env.SCRCPY || scrcpyHomeBin(process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
const SCRCPY_SERVER = process.env.SCRCPY_SERVER || scrcpyHomeBin('scrcpy-server');
const X_DISPLAY = process.env.X_DISPLAY || ':99';

// --- input mode (observe/interactive) ---
// WEB_CONTROL_TOKEN — bridge under MCP-agent control: browser input is disabled
// until the controller (connection with a valid token) sends input-mode.
// Without a token (manual run) — legacy behavior: input enabled;
// WEB_INPUT_ENABLED=0 explicitly enables observation mode.
const WEB_CONTROL_TOKEN = process.env.WEB_CONTROL_TOKEN || null;
let devInputEnabled = WEB_CONTROL_TOKEN ? false : process.env.WEB_INPUT_ENABLED !== '0';
// WEB_ACCESS_TOKEN — access to HTTP and WS only with this token (query ?token=,
// X-Access-Token header or Authorization: Bearer). Set by MCP on every bridge
// start; manual run without the variable works as before (no authentication).
const WEB_ACCESS_TOKEN = process.env.WEB_ACCESS_TOKEN || null;
const WEBP_QUALITY = 50;
// primary h264 source: 'scrcpy' (no 180s limit, length-prefixed framing) or 'screenrecord' (fallback)
const VIDEO_SRC = process.env.VIDEO_SRC === 'screenrecord' ? 'screenrecord' : 'scrcpy';

// fps — measured limit of x11grab+libwebp (compression_level 1); srSize — encode size of h264
// and the webp-path window (see encSizeMax), null = native 1080x2400. The full tier is also encoded
// at 486x1080: a software-rendered emulator's encoder is real-time only up to that size, native accumulates a queue -> seconds of delay.
// max — fallback size when srSize=null (0 = native).
const RESOLUTIONS = {
  '324x720':   { max: 720,  bitrate: '3M', fps: 30, srSize: '324x720' },
  '486x1080':  { max: 1080, bitrate: '4M', fps: 30, srSize: '486x1080' },
  '1004x2231': { max: 0,    bitrate: '4M', fps: 30, srSize: '486x1080' },
};
const DEFAULT_RES = '486x1080';

// upper size bound for the h264 encode (scrcpy max_size, screenrecord --size) and the
// desktop-scrcpy window (webp): a software-rendered emulator's encoder is real-time only up to 486x1080, a larger size
// (including native 1080x2400) accumulates a queue -> delay grows to seconds on any path
function encSizeMax(cfg) {
  return cfg.srSize ? parseInt(cfg.srSize.split('x')[1], 10) : (cfg.max || 0);
}

let cachedVersion = null;
let ffmpegProc = null;
let scrcpyProc = null;
let streaming = false;
let clients = new Set();
let curW = 0, curH = 0, curX = 0, curY = 0;
let curRes = DEFAULT_RES;
let curScrcpyPgrp = 0;

// --- H.264 pipeline: screenrecord -> WS -> browser WebCodecs ---
let srProc = null;
let srCycleTimer = null;
let srRespawnTimer = null;
let h264Buf = Buffer.alloc(0);
let auChunks = [];          // NAL units of the current access unit, including start codes
let auHasVCL = false;
let auIsKey = false;
let lastKeyAU = null;       // keyframe for instant start of new clients
const START_CODE = Buffer.from([0, 0, 1]);

function clientsByCodec(codec) {
  const out = [];
  for (const ws of clients) if (ws.codec === codec && ws.readyState === 1) out.push(ws);
  return out;
}

function broadcastWebp(data) {
  const copy = Buffer.from(data);
  for (const ws of clientsByCodec('webp')) ws.send(copy);
}

function broadcastH264(msg) {
  for (const ws of clientsByCodec('h264')) ws.send(msg);
}

function adb(args) {
  return new Promise((resolve, reject) => {
    exec(`"${ADB}" shell ${args}`, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      err ? reject(err) : resolve(stdout);
    });
  });
}

function execCmd(cmd, args) {
  return new Promise((resolve) => {
    exec(cmd + ' ' + args.join(' '), { env: { ...process.env, DISPLAY: X_DISPLAY }, timeout: 5000 }, (err, stdout) => {
      resolve(stdout ? stdout.trim() : '');
    });
  });
}

async function detectScrcpyWindow() {
  if (!curScrcpyPgrp) return null;
  const pid = curScrcpyPgrp;
  const out = await execCmd('xwininfo', ['-root', '-tree', '-display', X_DISPLAY]);
  for (const line of out.split('\n')) {
    if (!line.includes('"scrcpy"') && !line.includes('gphone')) continue;
    const m = line.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/);
    if (!m) continue;
    const wid = line.trim().split(/\s+/)[0];
    const prop = await execCmd('xprop', ['-id', wid, '-display', X_DISPLAY, '_NET_WM_PID']);
    const pm = prop.match(/_NET_WM_PID\s*\(\s*CARDINAL\s*\)\s*=\s*(\d+)/i);
    if (pm && parseInt(pm[1]) === pid) {
      return { w: parseInt(m[1]), h: parseInt(m[2]), x: parseInt(m[3]), y: parseInt(m[4]) };
    }
  }
  return null;
}

function startScrcpy(maxSize, bitrate) {
  if (!SCRCPY) {
    console.error('[scrcpy] binary not found — set SCRCPY env');
    return;
  }
  const args = [
    '--max-size', String(maxSize),
    '--video-bit-rate', bitrate,
    '--no-audio', '--no-control'
  ];
  const proc = spawn(SCRCPY, args, {
    env: { ...process.env, DISPLAY: X_DISPLAY },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  scrcpyProc = proc;
  curScrcpyPgrp = proc.pid;
  proc.stderr.on('data', () => {});
  proc.on('close', (code) => {
    // event from an instance killed during a resolution switch: the current one is already different
    if (scrcpyProc !== proc) return;
    console.log('[bridge] scrcpy exited, code:', code);
    scrcpyProc = null;
    curScrcpyPgrp = 0;
    ensureDeviceWatch();
  });
  curW = 0; curH = 0; curX = 0; curY = 0;
  console.log(`[bridge] scrcpy started, max-size=${maxSize} bitrate=${bitrate}`);
  const poll = async () => {
    if (!scrcpyProc) return;
    const win = await detectScrcpyWindow();
    if (win) {
      curW = win.w; curH = win.h; curX = win.x; curY = win.y;
      execCmd('xdotool', ['mousemove', '0', '0']);
      console.log(`[bridge] scrcpy window: ${curW}x${curH}+${curX},${curY}`);
      if (streaming && clientsByCodec('webp').length > 0) startFfmpeg();
      // the window may keep settling after the connection (256x256 at boot) — keep watching
      const watch = async () => {
        if (!scrcpyProc) return;
        const w = await detectScrcpyWindow();
        if (w && (w.w !== curW || w.h !== curH || w.x !== curX || w.y !== curY)) {
          curW = w.w; curH = w.h; curX = w.x; curY = w.y;
          console.log(`[bridge] scrcpy window changed: ${curW}x${curH}+${curX},${curY}`);
          if (streaming && clientsByCodec('webp').length > 0) startFfmpeg();
        }
        setTimeout(watch, 2000);
      };
      setTimeout(watch, 2000);
    } else {
      setTimeout(poll, 500);
    }
  };
  setTimeout(poll, 1000);
}

function stopScrcpy() {
  scrcpyProc = null;
  if (curScrcpyPgrp) {
    try { process.kill(curScrcpyPgrp, 'SIGKILL'); } catch (e) {}
    exec(`pkill -9 -P ${curScrcpyPgrp} 2>/dev/null`, () => {});
    console.log(`[bridge] scrcpy stopping, killed ${curScrcpyPgrp}`);
  }
  curScrcpyPgrp = 0;
}

function startFfmpeg() {
  stopFfmpeg();
  const cfg = RESOLUTIONS[curRes];
  const args = [
    '-y', '-f', 'x11grab',
    '-video_size', `${curW}x${curH}`,
    '-framerate', String(cfg.fps),
    '-i', `${X_DISPLAY}.0+${curX},${curY}`,
    '-c:v', 'libwebp', '-q:v', String(WEBP_QUALITY), '-compression_level', '1',
    '-f', 'image2pipe', 'pipe:1'
  ];
  const proc = spawn(FFMPEG, args, {
    env: { ...process.env, DISPLAY: X_DISPLAY },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  ffmpegProc = proc;
  proc.stderr.on('data', () => {});

  const RIFF = Buffer.from('RIFF');
  const WEBP = Buffer.from('WEBP');
  let buffer = Buffer.alloc(0);

  proc.stdout.on('data', (chunk) => {
    // frames from an instance replaced during an ffmpeg restart are not sent to clients
    if (ffmpegProc !== proc) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const riff = buffer.indexOf(RIFF);
      if (riff === -1) { buffer = Buffer.alloc(0); break; }
      if (buffer.length < riff + 12) break;
      if (buffer.compare(WEBP, 0, 4, riff + 8, riff + 12) !== 0) {
        buffer = buffer.subarray(riff + 4);
        continue;
      }
      const size = buffer.readUInt32LE(riff + 4) + 8;
      if (buffer.length < riff + size) break;
      const frame = Buffer.from(buffer.subarray(riff, riff + size));
      buffer = buffer.subarray(riff + size);
      if (frame.length > 100) {
        broadcastWebp(frame);
      }
    }
  });

  proc.on('close', (code) => {
    // event from an instance killed during an ffmpeg restart: the current one is already different,
    // clearing the reference would kill the new process (the leaked ffmpeg would keep streaming)
    if (ffmpegProc !== proc) return;
    console.log('[bridge] ffmpeg exited, code:', code);
    ffmpegProc = null;
  });
  console.log(`[bridge] ffmpeg started, ${curW}x${curH}+${curX},${curY} webp q${WEBP_QUALITY} @${cfg.fps}fps`);
}

function stopFfmpeg() {
  if (!ffmpegProc) return;
  const p = ffmpegProc;
  ffmpegProc = null;
  p.kill('SIGKILL');
  console.log('[bridge] ffmpeg stopping');
}

// --- H.264: parsing the screenrecord Annex-B stream into access units (frames) ---

function emitAU() {
  if (!auHasVCL) return;
  const au = Buffer.concat(auChunks);
  const msg = Buffer.allocUnsafe(au.length + 1);
  msg[0] = auIsKey ? 1 : 0;
  au.copy(msg, 1);
  if (auIsKey) lastKeyAU = { msg, ts: Date.now() };
  broadcastH264(msg);
  auChunks = [];
  auHasVCL = false;
  auIsKey = false;
}

function feedNal(type, nal) {
  const isVCL = type === 1 || type === 5;
  if (type === 9 || (isVCL && auHasVCL) || ((type === 7 || type === 8) && auHasVCL)) emitAU();
  auChunks.push(nal);
  if (isVCL) { auHasVCL = true; if (type === 5) auIsKey = true; }
}

function startCodePositions() {
  const positions = [];
  for (let i = h264Buf.indexOf(START_CODE); i !== -1; i = h264Buf.indexOf(START_CODE, i + 3)) positions.push(i);
  return positions;
}

let srIdleTimer = null;

function feedH264(chunk) {
  h264Buf = h264Buf.length ? Buffer.concat([h264Buf, chunk]) : chunk;
  const positions = startCodePositions();
  for (let k = 0; k + 1 < positions.length; k++) {
    const sc = positions[k];
    const nalStart = sc + 3;
    const end = positions[k + 1];
    if (end <= nalStart) continue;
    feedNal(h264Buf[nalStart] & 0x1f, Buffer.from(h264Buf.subarray(sc, end)));
  }
  if (positions.length) h264Buf = h264Buf.subarray(positions[positions.length - 1]);
  // the encoder only writes frames on content change: we close the AU after 120ms of silence,
  // otherwise the first (and only) frame on a static screen is never emitted
  clearTimeout(srIdleTimer);
  srIdleTimer = setTimeout(() => { if (auHasVCL) flushH264(); }, 120);
}

function flushH264() {
  const positions = startCodePositions();
  for (const sc of positions) {
    const nalStart = sc + 3;
    if (nalStart >= h264Buf.length) continue;
    feedNal(h264Buf[nalStart] & 0x1f, Buffer.from(h264Buf.subarray(sc)));
  }
  emitAU();
  auChunks = [];
  auHasVCL = false;
  auIsKey = false;
  h264Buf = Buffer.alloc(0);
}

function startScreenrecord() {
  stopScreenrecord();
  const cfg = RESOLUTIONS[curRes];
  const args = ['exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', cfg.bitrate, '--time-limit', '175'];
  if (cfg.srSize) args.push('--size', cfg.srSize);
  args.push('-');
  const proc = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const spawnedAt = Date.now();
  srProc = proc;
  h264Buf = Buffer.alloc(0);
  auChunks = [];
  auHasVCL = false;
  auIsKey = false;
  proc.stdout.on('data', feedH264);
  proc.stderr.on('data', () => {});
  proc.on('error', (e) => console.error('[bridge] screenrecord spawn error:', e.message));
  proc.on('close', () => {
    if (srProc !== proc) return;
    flushH264();
    srProc = null;
    if (clientsByCodec('h264').length > 0) {
      const lived = Date.now() - spawnedAt;
      srRespawnTimer = setTimeout(startScreenrecord, lived > 5000 ? 700 : 3000);
    }
  });
  // screenrecord limit is 180s; we cycle early with a soft SIGINT on the device
  srCycleTimer = setTimeout(() => {
    exec(`${ADB} shell pkill -INT screenrecord 2>/dev/null`, () => {});
  }, 170000);
  console.log(`[bridge] screenrecord started, res=${curRes} bitrate=${cfg.bitrate}`);
}

function stopScreenrecord() {
  clearTimeout(srCycleTimer);
  clearTimeout(srRespawnTimer);
  clearTimeout(srIdleTimer);
  if (!srProc) return;
  const p = srProc;
  srProc = null;
  p.kill('SIGKILL');
  exec(`${ADB} shell pkill -INT screenrecord 2>/dev/null`, () => {});
  console.log('[bridge] screenrecord stopping');
}

// --- scrcpy host: two instances of server 4.1 ---
// video server (control=false): h264 stream only.
// control server (video=false): input + clipboard, coordinates = display pixels.
// Why two: with video=true the server maps touch coordinates from the video-frame space
// via PositionMapper, and display pixels do not arrive (verified: a swipe from the status
// bar opens the notification shade only on the video=false instance). A separate control server
// also survives video resolution switches.

// Protocol (empirically confirmed on v4.1, jar decompilation + C client):
//   reverse localabstract:scrcpy_<scid-hex> -> the server connects its own sockets
//   video: [64B name][4B 'h264'][12B session: u64(0x80..|w)+u32 h]
//          then packets [u64 pts_flags][u32 size][Annex-B]: bit62=config, bit61=keyframe
//   control: the client writes messages; the device answers with device messages
//          [1B type]; type0=clipboard [4B len][utf8], type1=ack [8B seq]

const SCID_VIDEO = '77656231';
const SCID_CTRL = '77656232';

function makeScrcpyInstance({ scid, video, label, onSocket, onDied, skipPush }) {
  const st = { token: 0, proc: null, sock: null, listenSrv: null };
  return {
    running() { return !!st.proc; },
    sock() { return st.sock; },
    start() {
      this.stop();
      const token = ++st.token;
      st.listenSrv = net.createServer((sock) => {
        if (token !== st.token || st.sock) { sock.destroy(); return; }
        st.sock = sock;
        sock.on('data', (chunk) => { if (token === st.token) onSocket(chunk); });
        sock.on('close', () => {
          if (token !== st.token || st.sock !== sock) return;
          console.log(`[scrcpy:${label}] socket closed`);
          st.sock = null;
          onDied('socket closed');
        });
        sock.on('error', () => {});
        console.log(`[scrcpy:${label}] socket up`);
      });
      st.listenSrv.listen(0, '127.0.0.1', () => {
        if (token !== st.token) { st.listenSrv.close(); return; }
        const port = st.listenSrv.address().port;
        const afterPush = () => {
          exec(`${ADB} reverse localabstract:scrcpy_${scid} tcp:${port}`, (err) => {
            if (err || token !== st.token) { if (token === st.token) onDied('reverse failed'); return; }
            if (token !== st.token) return;
            const args = ['shell',
              'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
              'app_process / com.genymobile.scrcpy.Server 4.1',
              'log_level=warn',
              `video=${video}`, 'audio=false', `control=${!video}`,
            ];
            if (video) {
              const cfg = RESOLUTIONS[curRes];
              args.push(`max_size=${encSizeMax(cfg)}`, `max_fps=${cfg.fps}`,
                `video_bit_rate=${parseInt(cfg.bitrate, 10) * 1000000}`);
            }
            args.push(`scid=${scid}`, 'cleanup=false');
            const proc = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const spawnedAt = Date.now();
            st.proc = proc;
            proc.stderr.on('data', (d) => {
              const line = d.toString().trim();
              if (line) console.log(`[scrcpy:${label}]`, line);
            });
            let stderr = '';
            proc.stdout.on('data', () => {});
            proc.on('close', (code) => {
              if (token !== st.token) return;
              st.proc = null;
              if (stderr.trim()) console.error(`[scrcpy:${label}] stderr:`, stderr.trim().split('\n').slice(0, 4).join(' | '));
              onDied(`exited code=${code} after ${((Date.now() - spawnedAt) / 1000).toFixed(0)}s`);
            });
            console.log(`[scrcpy:${label}] starting, fwd=${port}`);
          });
        };
        if (skipPush) afterPush();
        else if (!SCRCPY_SERVER) onDied('SCRCPY_SERVER not found — set SCRCPY_SERVER env');
        else exec(`"${ADB}" push "${SCRCPY_SERVER}" /data/local/tmp/scrcpy-server.jar`, (perr) => {
          if (perr || token !== st.token) { if (token === st.token) onDied('push failed'); return; }
          afterPush();
        });
      });
    },
    stop() {
      const h = { ...st };
      st.token++;
      st.proc = null;
      st.sock = null;
      st.listenSrv = null;
      if (h.sock) h.sock.destroy();
      if (h.listenSrv) h.listenSrv.close();
      if (h.proc) {
        h.proc.kill('SIGKILL');
        exec(`${ADB} shell pkill -f 'scid=${scid}' 2>/dev/null`, () => {});
        exec(`${ADB} reverse --remove localabstract:scrcpy_${scid} 2>/dev/null`, () => {});
        console.log(`[scrcpy:${label}] stopping`);
      }
    },
  };
}

// --- video instance: h264 parsing ---

let hostConfigAU = null;
let videoRespawnTimer = null;

const videoHost = makeScrcpyInstance({
  scid: SCID_VIDEO,
  video: true,
  label: 'video',
  onDied(why) {
    console.log('[scrcpy:video] died:', why);
    videoHost.stop();
    if (clientsByCodec('h264').length > 0) {
      const delay = why === 'reverse failed' || why === 'push failed' ? 3000 : 700;
      clearTimeout(videoRespawnTimer);
      videoRespawnTimer = setTimeout(startVideoHost, delay);
    }
  },
  onSocket: parseVideoStream,
});

function startVideoHost() {
  clearTimeout(videoRespawnTimer);
  videoBuf = Buffer.alloc(0);
  videoHandshaked = false;
  videoHost.start();
}

function stopVideoHost() {
  clearTimeout(videoRespawnTimer);
  videoHost.stop();
}

let videoBuf = Buffer.alloc(0);
let videoHandshaked = false;
function parseVideoStream(chunk) {
  videoBuf = Buffer.concat([videoBuf, chunk]);
  // handshake: [64B name][4B codec][12B session: u64(0x80..|w) + u32 h]
  if (!videoHandshaked) {
    if (videoBuf.length < 80) return;
    const codec = videoBuf.subarray(64, 68).toString();
    if (codec !== 'h264') { console.error('[scrcpy:video] unexpected codec:', codec); stopVideoHost(); return; }
    const w = videoBuf.readUInt32BE(72);
    const h = videoBuf.readUInt32BE(76);
    videoHandshaked = true;
    videoBuf = videoBuf.subarray(80);
    console.log(`[scrcpy:video] stream up, frame=${w}x${h}`);
  }
  // packets: [u64 pts_flags][u32 size][payload]; bit62=config, bit61=keyframe
  while (videoBuf.length >= 12) {
    const f0 = videoBuf[0];
    const size = videoBuf.readUInt32BE(8);
    if (videoBuf.length < 12 + size) break;
    const payload = Buffer.from(videoBuf.subarray(12, 12 + size));
    videoBuf = videoBuf.subarray(12 + size);
    if (f0 & 0x40) {
      hostConfigAU = payload;
    } else {
      const isKey = !!(f0 & 0x20);
      const au = isKey && hostConfigAU ? Buffer.concat([hostConfigAU, payload]) : payload;
      const msg = Buffer.allocUnsafe(au.length + 1);
      msg[0] = isKey ? 1 : 0;
      au.copy(msg, 1);
      if (isKey) lastKeyAU = { msg, ts: Date.now() };
      broadcastH264(msg);
    }
  }
}

// --- control instance: input + clipboard ---

let ctrlRespawnTimer = null;
let ctrlNameBuf = Buffer.alloc(0);
let ctrlNameSkipped = false;

const ctrlHost = makeScrcpyInstance({
  scid: SCID_CTRL,
  video: false,
  label: 'ctrl',
  skipPush: true,
  onDied(why) {
    console.log('[scrcpy:ctrl] died:', why);
    ctrlHost.stop();
    if (clients.size > 0) {
      clearTimeout(ctrlRespawnTimer);
      ctrlRespawnTimer = setTimeout(startCtrlHost, 3000);
    }
  },
  onSocket: (chunk) => {
    // the ctrl socket also opens with a 64B device name — we skip it
    if (!ctrlNameSkipped) {
      ctrlNameBuf = Buffer.concat([ctrlNameBuf, chunk]);
      if (ctrlNameBuf.length < 64) return;
      chunk = ctrlNameBuf.subarray(64);
      ctrlNameSkipped = true;
      if (!chunk.length) return;
    }
    parseDeviceMessages(chunk);
  },
});

function startCtrlHost() {
  clearTimeout(ctrlRespawnTimer);
  ctrlNameBuf = Buffer.alloc(0);
  ctrlNameSkipped = false;
  ctrlHost.start();
}

function stopCtrlHost() {
  clearTimeout(ctrlRespawnTimer);
  ctrlHost.stop();
}

function ctrlReady() {
  const sock = ctrlHost.sock();
  return !!sock && !sock.destroyed;
}

// device messages: [1B type]; clipboard [len u32][utf8]; ack [seq i64]
let devBuf = Buffer.alloc(0);
function parseDeviceMessages(chunk) {
  devBuf = Buffer.concat([devBuf, chunk]);
  for (;;) {
    if (devBuf.length < 1) return;
    const type = devBuf[0];
    if (type === 0) {
      if (devBuf.length < 5) return;
      const len = devBuf.readUInt32BE(1);
      if (devBuf.length < 5 + len) return;
      const text = devBuf.subarray(5, 5 + len).toString('utf8');
      devBuf = devBuf.subarray(5 + len);
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'clip', text }));
      }
    } else if (type === 1) {
      if (devBuf.length < 9) return;
      devBuf = devBuf.subarray(9);
    } else {
      devBuf = Buffer.alloc(0);
      return;
    }
  }
}

// --- control: input injection via scrcpy, adb fallback ---
// the position in v4.1 control messages — raw pixels (verified: a swipe from the status bar
// opens the notification shade only with pixel coordinates; normalized 16.16 does not work)

function injectTouch(action, x, y, pressure) {
  if (!ctrlReady()) return false;
  const b = Buffer.alloc(32);
  let o = 0;
  b[o++] = 2;                          // TYPE_INJECT_TOUCH_EVENT
  b[o++] = action;                     // 0=DOWN 1=UP 2=MOVE
  b.writeBigInt64BE(-1n, o); o += 8;   // pointer id: generic finger
  b.writeUInt32BE(x, o); o += 4;
  b.writeUInt32BE(y, o); o += 4;
  b.writeUInt16BE(1080, o); o += 2;
  b.writeUInt16BE(2400, o); o += 2;
  b.writeUInt16BE(pressure ? 0xffff : 0, o); o += 2;
  b.writeUInt32BE(1, o); o += 4;       // actionButton: PRIMARY (0 does not work — verified)
  b.writeUInt32BE(action === 0 || action === 2 ? 1 : 0, o); // buttons
  ctrlHost.sock().write(b);
  return true;
}

function injectKeycode(keycode) {
  if (!ctrlReady()) return false;
  const b = Buffer.alloc(14);
  let o = 0;
  b[o++] = 0;                  // TYPE_INJECT_KEYCODE
  b[o++] = 0;                  // ACTION_DOWN
  b.writeUInt32BE(keycode, o); o += 4;
  b.writeUInt32BE(0, o); o += 4;   // repeat
  b.writeUInt32BE(0, o); o += 4;   // metaState
  ctrlHost.sock().write(b);
  b[1] = 1;                    // ACTION_UP
  ctrlHost.sock().write(b);
  return true;
}

// Non-ASCII (Cyrillic, CJK, …) is not injected via scrcpy INJECT_TEXT — the server
// finds no keycode for the unicode character (WARN: Could not inject char). So for such
// characters we switch the IME to ADBKeyBoard, send an ADB_INPUT_TEXT broadcast, then restore the IME.
const ADBKB_ID = 'com.android.adbkeyboard/.AdbIME';
let savedIme = null;
function hasNonAscii(s) { return /[\u0080-\uFFFF]/.test(s); }

async function ensureAdbKeyboard() {
  try {
    const cur = (await adb('settings get secure default_input_method')).trim();
    if (cur !== ADBKB_ID) {
      if (!savedIme) savedIme = cur;
      await adb(`ime set ${ADBKB_ID}`);
      await new Promise((r) => setTimeout(r, 500)); // ime set is async — give it time to apply
    }
  } catch (e) { console.error('[adbkb] ensure:', e.message); }
}
async function restoreAdbKeyboard() {
  try {
    const cur = (await adb('settings get secure default_input_method')).trim();
    if (cur === ADBKB_ID && savedIme) {
      await adb(`ime set ${savedIme}`);
      savedIme = null;
    }
  } catch (e) { console.error('[adbkb] restore:', e.message); }
}

async function injectText(text) {
  if (hasNonAscii(text)) {
    await ensureAdbKeyboard();
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const out = await adb(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
    await restoreAdbKeyboard();
    return true;
  }
  if (!ctrlReady()) return false;
  const payload = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b[0] = 1;                    // TYPE_INJECT_TEXT
  b.writeUInt32BE(payload.length, 1);
  payload.copy(b, 5);
  ctrlHost.sock().write(b);
  return true;
}

function injectScroll(x, y, steps) {
  if (!ctrlReady()) return false;
  for (let i = 0; i < steps; i++) {
    setTimeout(() => {
      if (!ctrlReady()) return;
      const b = Buffer.alloc(21);
      let o = 0;
      b[o++] = 3;                  // TYPE_INJECT_SCROLL_EVENT
      b.writeUInt32BE(x, o); o += 4;
      b.writeUInt32BE(y, o); o += 4;
      b.writeUInt16BE(1080, o); o += 2;
      b.writeUInt16BE(2400, o); o += 2;
      b.writeInt16BE(0, o); o += 2;      // hScroll i16 fixpoint
      b.writeInt16BE(-32767, o); o += 2; // vScroll: negative = scroll down
      b.writeUInt32BE(0, o);             // buttons
      ctrlHost.sock().write(b);
    }, i * 40);
  }
  return true;
}

function setClipboard(text, paste) {
  if (!ctrlReady()) return { ok: false };
  const payload = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(14 + payload.length);
  let o = 0;
  b[o++] = 9;                          // TYPE_SET_CLIPBOARD
  b.writeBigInt64BE(BigInt(Date.now() % 0x7fffffff), o); o += 8; // sequence
  b[o++] = paste ? 1 : 0;
  b.writeUInt32BE(payload.length, o); o += 4;
  payload.copy(b, o);
  ctrlHost.sock().write(b);
  return { ok: true };
}

function getClipboard() {
  if (!ctrlReady()) return false;
  const b = Buffer.alloc(2);
  b[0] = 8; b[1] = 1;
  ctrlHost.sock().write(b);
  return true;
}

// after the device disappears, scrcpy cannot bring itself back (the window poll stops) —
// we wait for the device to return and start over
let deviceWatchTimer = null;
function ensureDeviceWatch() {
  if (deviceWatchTimer) return;
  deviceWatchTimer = setInterval(async () => {
    if (scrcpyProc && (VIDEO_SRC === 'screenrecord' || !clientsByCodec('h264').length || videoHost.running())) {
      clearInterval(deviceWatchTimer);
      deviceWatchTimer = null;
      return;
    }
    let booted = false;
    try { booted = (await adb('getprop sys.boot_completed')).trim() === '1'; } catch { return; }
    if (!booted) return;
    clearInterval(deviceWatchTimer);
    deviceWatchTimer = null;
    console.log('[bridge] device back, restarting streams');
    const cfg = RESOLUTIONS[curRes];
    startScrcpy(encSizeMax(cfg), cfg.bitrate);
    if (VIDEO_SRC === 'scrcpy' && clientsByCodec('h264').length > 0) startVideoHost();
    if (clients.size > 0) startCtrlHost();
  }, 3000);
}

function changeResolution(name) {
  const cfg = RESOLUTIONS[name];
  if (!cfg) return false;
  if (name === curRes) return true;
  stopFfmpeg();
  stopScrcpy();
  curRes = name;
  lastKeyAU = null;
  const note = JSON.stringify({ type: 'res', name });
  for (const cl of clients) if (cl.readyState === 1) cl.send(note);
  startScrcpy(encSizeMax(cfg), cfg.bitrate);
  if (VIDEO_SRC === 'scrcpy') {
    if (clientsByCodec('h264').length > 0) startVideoHost();
  } else if (clientsByCodec('h264').length > 0) {
    startScreenrecord();
  }
  return true;
}

// --- ABR: auto resolution based on network throughput ---
// The signal is ws-ping/pong RTT (1s): if the client's network is below the tier's bitrate, the queue on the
// path to the client grows and the ping passes through it -> RTT exceeds the threshold. The browser answers the
// ping automatically (RFC 6455), no client code needed. Secondary safety net is
// ws.bufferedAmount (trips later, after the kernel TCP buffers are exhausted).
// Long period without congestion -> step up (hysteresis).
// 1004x2231 is off the ladder: its encode/bitrate = that of the 486x1080 tier, there is no signal to distinguish them.
const ABR = {
  ladder: ['324x720', '486x1080'],
  checkMs: parseInt(process.env.ABR_CHECK_MS || '2000', 10),
  downBytes: parseInt(process.env.ABR_DOWN_BYTES || '600000', 10),
  rttMs: parseInt(process.env.ABR_RTT_MS || '800', 10),
  upSecs: parseInt(process.env.ABR_UP_SECS || '90', 10),
  cooldownSecs: parseInt(process.env.ABR_COOLDOWN_SECS || '10', 10),
};
let abrHealthySecs = 0;
let abrLastSwitch = 0;
let abrLastSlow = 0;

function abrAdjust(dir) {
  const now = Date.now();
  if (now - abrLastSwitch < ABR.cooldownSecs * 1000) return;
  const idx = ABR.ladder.indexOf(curRes);
  if (idx === -1) return; // tier set manually and off the ladder — leave it alone
  const next = idx + dir;
  if (next < 0 || next >= ABR.ladder.length) return;
  console.log(`[abr] ${dir < 0 ? 'network cannot keep up' : 'headroom available'} — ${curRes} → ${ABR.ladder[next]}`);
  abrLastSwitch = now;
  abrHealthySecs = 0;
  changeResolution(ABR.ladder[next]);
}

function abrClientSlow() {
  const now = Date.now();
  if (now - abrLastSlow < 5000) return;
  abrLastSlow = now;
  abrHealthySecs = 0;
  abrAdjust(-1);
}

function abrOnPong(ws, rtt) {
  ws.rttMin = Math.min(ws.rttMin, rtt);
  // threshold: absolute floor + a multiple of the baseline RTT (200ms cap so an initial
  // measurement on a loaded channel does not block detection)
  const limit = Math.max(ABR.rttMs, 5 * Math.min(ws.rttMin, 200));
  ws.rttSlow = rtt > limit ? ws.rttSlow + 1 : 0;
  if (ws.rttSlow >= 2) {
    ws.rttSlow = 0;
    abrClientSlow();
  }
}

setInterval(() => {
  const now = Date.now();
  if (now - abrLastSwitch < ABR.cooldownSecs * 1000) return;
  const active = [];
  for (const ws of clients) if (ws.readyState === 1) active.push(ws);
  if (!active.length) { abrHealthySecs = 0; return; }
  const backlog = Math.max(...active.map((ws) => ws.bufferedAmount));
  if (backlog > ABR.downBytes) {
    abrHealthySecs = 0;
    abrAdjust(-1);
    return;
  }
  abrHealthySecs += ABR.checkMs / 1000;
  if (abrHealthySecs >= ABR.upSecs) abrAdjust(+1);
}, ABR.checkMs);

// RTT probes: payload = 8-byte big-endian send timestamp
const PING_TS = Buffer.allocUnsafe(8);
setInterval(() => {
  PING_TS.writeBigUInt64BE(BigInt(Date.now()));
  for (const ws of clients) if (ws.readyState === 1) ws.ping(PING_TS);
}, 1000);

async function handleInputMsg(ws, d) {
  try {
    if (!(ws && ws.isController) && !devInputEnabled) return; // observation mode: input is dropped
    // scrcpy control channel: per-input injection with no process (~5ms vs ~50-300ms for adb)
    if (ctrlReady()) {
      switch (d.type) {
        case 'tap':
          injectTouch(0, d.x, d.y, true);
          setTimeout(() => injectTouch(1, d.x, d.y, false), 60);
          return;
        case 'swipe': {
          const ms = d.ms || 300;
          const steps = 8;
          injectTouch(0, d.x1, d.y1, true);
          for (let i = 1; i <= steps; i++) {
            const x = Math.round(d.x1 + (d.x2 - d.x1) * i / steps);
            const y = Math.round(d.y1 + (d.y2 - d.y1) * i / steps);
            setTimeout(() => injectTouch(i < steps ? 2 : 1, x, y, i < steps), ms * i / steps);
          }
          return;
        }
        case 'key':
          injectKeycode(d.code);
          return;
        case 'text':
          if (await injectText(d.text)) return;
          break;
        case 'scroll':
          injectScroll(d.x, d.y, d.dy || 1);
          return;
      }
    }
    switch (d.type) {
      case 'tap':
        await adb(`input tap ${d.x} ${d.y}`);
        break;
      case 'swipe':
        await adb(`input swipe ${d.x1} ${d.y1} ${d.x2} ${d.y2} ${d.ms || 300}`);
        break;
      case 'key':
        await adb(`input keyevent ${d.code}`);
        break;
      case 'text':
        const escaped = d.text.replace(/'/g, "'\\''");
        await adb(`input text '${escaped}'`);
        break;
      case 'scroll':
        const dy = (d.dy || 1) > 0 ? 400 : -400;
        await adb(`input swipe ${d.x} ${d.y} ${d.x} ${d.y + dy} 200`);
        break;
      case 'clip-set':
        if (!setClipboard(d.text, d.paste)) console.error('[clip] control channel not ready');
        break;
      case 'clip-get':
        if (!getClipboard()) console.error('[clip] control channel not ready');
        break;
    }
  } catch (e) {
    console.error('[input] error:', e.message);
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function authorized(req, url) {
  if (!WEB_ACCESS_TOKEN) return true;
  const q = url.searchParams.get('token');
  const h = req.headers['x-access-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return q === WEB_ACCESS_TOKEN || h === WEB_ACCESS_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (!authorized(req, url)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  if (pathname === '/version') {
    try {
      if (!cachedVersion) {
        cachedVersion = await adb('getprop ro.build.version.release');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(cachedVersion.trim());
    } catch (e) {
      res.writeHead(500);
      res.end('unknown');
    }
    return;
  }
  if (pathname === '/resolutions' && req.method === 'GET') {
    json(res, 200, { current: curRes, options: Object.keys(RESOLUTIONS) });
    return;
  }
  if (pathname === '/resolution' && req.method === 'POST') {
    const name = url.searchParams.get('name');
    if (!RESOLUTIONS[name]) {
      json(res, 400, { error: 'unknown resolution' });
      return;
    }
    const ok = changeResolution(name);
    json(res, ok ? 200 : 500, { ok, current: curRes });
    return;
  }
  if (pathname === '/push' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || 'file.bin').replace(/[^A-Za-z0-9._-]/g, '_');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 800 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      const tmp = path.join(os.tmpdir(), `wepush-${name}`);
      fs.writeFile(tmp, Buffer.concat(chunks), (werr) => {
        if (werr) { json(res, 500, { ok: false, error: werr.message }); return; }
        const isApk = name.toLowerCase().endsWith('.apk');
        const cmd = isApk
          ? `"${ADB}" install -r -t "${tmp}"`
          : `"${ADB}" push "${tmp}" /sdcard/Download/`;
        exec(cmd, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err2, stdout) => {
          fs.unlink(tmp, () => {});
          json(res, err2 ? 500 : 200, { ok: !err2, kind: isApk ? 'install' : 'push', out: (stdout || err2?.message || '').trim().split('\n').slice(-2).join(' | ') });
        });
      });
    });
    return;
  }
  if (pathname === '/state') {
    json(res, 200, {
      inputEnabled: devInputEnabled,
      controlled: !!WEB_CONTROL_TOKEN,
      host: HOST,
      port: PORT,
      resolution: curRes,
      version: cachedVersion ? cachedVersion.trim() : null,
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!authorized(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.codec = 'webp';
  ws.rttMin = Infinity;
  ws.rttSlow = 0;
  ws.on('pong', (data) => {
    if (data && data.length === 8) abrOnPong(ws, Date.now() - Number(data.readBigUInt64BE(0)));
  });
  clients.add(ws);
  console.log('[bridge] client connected, total:', clients.size);
  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length >= 200) return;
    let d;
    try { d = JSON.parse(data.toString()); } catch { return; }
    if (d.type === 'init') {
      ws.isController = !!(WEB_CONTROL_TOKEN && d.token && d.token === WEB_CONTROL_TOKEN);
      ws.codec = d.codec === 'h264' ? 'h264' : (d.codec === 'webp' ? 'webp' : 'none');
      console.log(`[bridge] client codec: ${ws.codec}${ws.isController ? ' (controller)' : ''}`);
      ws.send(JSON.stringify({ type: 'input-mode', enabled: devInputEnabled }));
      if (ws.codec === 'h264') {
        if (VIDEO_SRC === 'scrcpy') {
          // the stream is content-driven: on a static screen a new client receives the cached
          // keyframe; if the cache is stale — we restart the host for a fresh IDR
          const fresh = lastKeyAU && Date.now() - lastKeyAU.ts < 1500;
          if (fresh) {
            ws.send(lastKeyAU.msg);
          }
          if (!videoHost.running()) startVideoHost();
      setTimeout(() => { if (clients.size > 0 && !ctrlHost.running()) startCtrlHost(); }, 600);
        } else {
          const fresh = lastKeyAU && Date.now() - lastKeyAU.ts < 1500;
          if (fresh) {
            ws.send(lastKeyAU.msg);
          } else {
            startScreenrecord();
          }
        }
      } else if (ws.codec === 'webp' && !streaming) {
        streaming = true;
        if (!ffmpegProc && curW > 0) startFfmpeg();
      }
      return;
    }
    if (d.type === 'input-mode') {
      if (!ws.isController || !WEB_CONTROL_TOKEN || d.token !== WEB_CONTROL_TOKEN) return;
      devInputEnabled = !!d.enabled;
      console.log('[bridge] dev input:', devInputEnabled ? 'enabled' : 'disabled');
      const note = JSON.stringify({ type: 'input-mode', enabled: devInputEnabled });
      for (const cl of clients) if (cl.readyState === 1) cl.send(note);
      return;
    }
    handleInputMsg(ws, d);
  });
  ws.on('close', () => {
    clients.delete(ws);
    console.log('[bridge] client left, total:', clients.size);
    if (clientsByCodec('webp').length === 0) {
      streaming = false;
      stopFfmpeg();
    }
    if (clientsByCodec('h264').length === 0) {
      if (VIDEO_SRC === 'scrcpy') stopVideoHost();
      else stopScreenrecord();
    }
    if (clients.size === 0) stopCtrlHost();
  });
});

const cfg = RESOLUTIONS[DEFAULT_RES];
startScrcpy(encSizeMax(cfg), cfg.bitrate);
server.listen(PORT, HOST, () => {
  console.log(`[bridge] http://${HOST}:${PORT} (X: ${X_DISPLAY}, res: ${curRes}, input: ${devInputEnabled ? 'on' : 'off'})`);
});

process.on('SIGINT', () => { stopFfmpeg(); stopScrcpy(); stopScreenrecord(); stopVideoHost(); stopCtrlHost(); process.exit(0); });
process.on('SIGTERM', () => { stopFfmpeg(); stopScrcpy(); stopScreenrecord(); stopVideoHost(); stopCtrlHost(); process.exit(0); });
