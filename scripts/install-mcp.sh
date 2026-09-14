#!/usr/bin/env bash
# DroidLab MCP installer (macOS / Linux).
#
# Safe by design — an installing agent must run THIS script instead of
# improvising with the system package manager:
#   * never runs `brew upgrade` / `brew reinstall` (a bare brew operation can
#     replace unrelated toolchains — this is exactly how opencode got broken
#     on 2026-09-14: `brew reinstall node` collateral-upgraded opencode);
#   * if node is missing entirely, installs it with guards that forbid
#     collateral upgrades of other formulae;
#   * registers the MCP server with an ABSOLUTE node path — GUI MCP clients
#     do not inherit the interactive shell PATH, a bare "node" fails there;
#   * smoke-tests the server over a real MCP stdio handshake.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO_DIR/mcp/server.mcp.mjs"
FALLBACK_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

log() { printf '[droidlab-install] %s\n' "$*"; }
die() { printf '[droidlab-install] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$SERVER" ] || die "server not found: $SERVER"

# ---------- 1. locate node (absolute path required) ----------
NODE_BIN=""
for c in "$(command -v node 2>/dev/null || true)" \
         /opt/homebrew/bin/node \
         /usr/local/bin/node \
         "$HOME/.local/bin/node" \
         /usr/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done

# Install node ONLY if missing. Guards forbid collateral upgrades of other
# formulae (HOMEBREW_NO_INSTALL_UPGRADE) and formula index refresh
# (HOMEBREW_NO_AUTO_UPDATE). `brew upgrade`/`brew reinstall` are never used.
if [ -z "$NODE_BIN" ]; then
  log "node not found — installing via Homebrew (collateral-upgrade guards ON)"
  command -v brew >/dev/null 2>&1 || die "no node and no brew; install Node.js >= 18 from https://nodejs.org and re-run this script"
  export HOMEBREW_NO_AUTO_UPDATE=1
  export HOMEBREW_NO_INSTALL_UPGRADE=1
  export HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install node
  NODE_BIN="$(command -v node)"
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "node binary not usable: ${NODE_BIN:-<none>}"
case "$NODE_BIN" in /*) ;; *) NODE_BIN="$(command -v node)" ;; esac
log "node: $NODE_BIN ($("$NODE_BIN" --version))"

# ---------- 2. repo-local dependencies ----------
log "npm install (repo-local, no global changes)"
(cd "$REPO_DIR" && npm install --no-fund --no-audit --silent) || die "npm install failed"

# ---------- 3. smoke test: MCP stdio handshake ----------
log "smoke test: MCP handshake"
NODE_BIN="$NODE_BIN" SERVER="$SERVER" FALLBACK_PATH="$FALLBACK_PATH" python3 - <<'PY' || die "MCP handshake smoke test failed"
import json, os, select, subprocess, sys
proc = subprocess.Popen(
    [os.environ["NODE_BIN"], os.environ["SERVER"]],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    env={"PATH": os.environ["FALLBACK_PATH"]},
)
def send(obj):
    proc.stdin.write((json.dumps(obj) + "\n").encode()); proc.stdin.flush()
def recv(timeout=15):
    r, _, _ = select.select([proc.stdout], [], [], timeout)
    if not r: return None
    line = proc.stdout.readline()
    return line.decode().strip() if line else None
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"droidlab-install","version":"1.0"}}})
init = recv()
if not init or "result" not in init: sys.exit("no/invalid initialize response")
send({"jsonrpc":"2.0","method":"notifications/initialized"})
send({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
tools = recv()
if not tools: sys.exit("no tools/list response")
n = len(json.loads(tools).get("result", {}).get("tools", []))
proc.stdin.close(); proc.terminate()
print(f"[droidlab-install] MCP OK: {n} tools")
PY

# ---------- 4. register in opencode config (JSONC-safe, idempotent) ----------
NODE_BIN="$NODE_BIN" SERVER="$SERVER" FALLBACK_PATH="$FALLBACK_PATH" python3 - <<'PY'
import json, os, re, sys, time

home = os.path.expanduser("~")
node = os.environ["NODE_BIN"]; server = os.environ["SERVER"]; fpath = os.environ["FALLBACK_PATH"]
block = (
    '"droidlab": {\n'
    '      "type": "local",\n'
    f'      "command": [{json.dumps(node)}, {json.dumps(server)}],\n'
    f'      "env": {{ "PATH": {json.dumps(fpath)} }},\n'
    '      "enabled": true\n'
    '    }'
)

candidates = [
    os.path.join(home, ".config/opencode/opencode.jsonc"),
    os.path.join(home, ".config/opencode/opencode.json"),
]
path = next((p for p in candidates if os.path.exists(p)), None)

def validate(text):
    stripped = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    stripped = re.sub(r",(\s*[}\]])", r"\1", stripped)
    json.loads(stripped)

if path is None:
    os.makedirs(os.path.join(home, ".config/opencode"), exist_ok=True)
    path = candidates[0]
    open(path, "w", encoding="utf-8").write('{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    ' + block + '\n  }\n}\n')
    print(f"[droidlab-install] created opencode config: {path}")
else:
    s = open(path, encoding="utf-8").read()
    backup = f"{path}.bak.{int(time.time())}"
    if '"droidlab"' in s:
        # already registered: repair a bare "node" if present (broken GUI setups)
        new = s.replace('"command": "node"', f'"command": {json.dumps(node)}')
        new = new.replace('"command": ["node"', f'"command": [{json.dumps(node)}')
        if '"droidlab"' in new and '"env"' not in new.split('"droidlab"', 1)[1].split("}", 1)[0]:
            new = re.sub(r'("command": \[[^\]]*server\.mcp\.mjs"\])', r'\1,\n      "env": { "PATH": ' + json.dumps(fpath) + ' }', new, count=1)
        if new != s:
            open(backup, "w", encoding="utf-8").write(s)
            open(path, "w", encoding="utf-8").write(new)
            print(f"[droidlab-install] repaired existing droidlab entry (backup: {backup})")
        else:
            print("[droidlab-install] droidlab already registered, nothing to change")
        validate(open(path, encoding="utf-8").read())
        sys.exit(0)
    open(backup, "w", encoding="utf-8").write(s)
    mcp_pos = s.find('"mcp"')
    if mcp_pos >= 0:
        brace = s.find("{", mcp_pos)
        s2 = s[:brace+1] + "\n    " + block + "," + s[brace+1:]
    else:
        root = s.find("{")
        s2 = s[:root+1] + '\n  "mcp": {\n    ' + block + '\n  },' + s[root+1:]
    try:
        validate(s2)
    except Exception as e:
        open(path, "w", encoding="utf-8").write(s)
        sys.exit(f"config edit did not validate, restored backup ({e})")
    open(path, "w", encoding="utf-8").write(s2)
    print(f"[droidlab-install] registered in {path} (backup: {backup})")
PY

# ---------- 5. done ----------
log "-------------------------------------------------------------"
log "installed. other MCP clients (Claude Desktop, Cursor, ...):"
cat <<EOF
  "mcpServers": {
    "droidlab": {
      "command": "$NODE_BIN",
      "args": ["$SERVER"]
    }
  }
EOF
log "NOTE: always use the ABSOLUTE node path above (GUI clients do not inherit the shell PATH)."
log "NOTE: this script never runs 'brew upgrade'/'brew reinstall'; keep it that way on this host."
