#!/usr/bin/env node
// CI smoke test: starts the MCP server over stdio, lists tools and verifies the
// registry against the expected set. No emulator / Android SDK required.
// The full live cycle lives in scripts/e2e-mcp.mjs (npm run e2e:mcp).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED = [
  'env_start', 'env_stop', 'env_status', 'env_list', 'reboot_emulator', 'adb_restart',
  'system_images_list', 'system_image_install', 'avd_create', 'list_devices',
  'screenshot', 'tap', 'swipe', 'scroll', 'key', 'text', 'clipboard_get', 'clipboard_set',
  'install_apk', 'push_file', 'pull_file', 'open_app', 'close_app', 'app_list', 'ui_dump',
  'wait_for', 'deep_link', 'app_permission',
  'logcat', 'device_state', 'access_start', 'access_stop', 'set_dev_input', 'set_resolution',
  'shell', 'emu', 'bugreport', 'app_uninstall', 'app_clear_data', 'bridge_logs', 'pinch', 'set_orientation', 'bridge_restart',
  'mcp_config',
];

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'mcp', 'server.mcp.mjs')],
  stderr: 'pipe',
});
const client = new Client({ name: 'ci-smoke', version: '0.0.1' });
await client.connect(transport);

const { tools } = await client.listTools();
check(`tools/list (${EXPECTED.length} tools)`, tools.length === EXPECTED.length,
  `got ${tools.length}`);

const missing = EXPECTED.filter((t) => !tools.some((x) => x.name === t));
const extra = tools.map((t) => t.name).filter((t) => !EXPECTED.includes(t));
check('no missing tools', missing.length === 0, missing.join(',') || 'ok');
check('no unexpected tools', extra.length === 0, extra.join(',') || 'ok');

const unannotated = tools.filter((t) => !t.annotations || t.annotations.readOnlyHint === undefined);
check('all tools have annotations', unannotated.length === 0, unannotated.map((t) => t.name).join(',') || 'ok');

await client.close();
process.exit(failed ? 1 : 0);
