#!/usr/bin/env bash
# Reference setup, one person per server [platform]. Run as ROOT on a fresh Ubuntu/Debian host that already has Node 22 and the
# engine checked out (and `npm ci` run) at /opt/workbench/briefing-table.
#
#   bash deploy/reference/setup-reference.sh [--dry-run]
#
# What it does (idempotent: a second run changes nothing and says so):
#   1. two accounts: `wbengine` (the engine, its data and secrets) and `wbagent` (the broker and every agent it spawns)
#   2. the directory tree and file modes in README.md "File modes"
#   3. a broker token (shared by the broker and the engine, 48 hex chars) and the two env files
#   4. installs the two systemd units; enables them only with --enable (does not start anything by default)
# It does NOT touch TLS, DNS, the proxy, vendor logins or backups: those are the deployer's (README.md "What you still own").
# It never prints a secret.
set -euo pipefail

DRY=0; ENABLE=0; NOACL=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --enable) ENABLE=1 ;;
    --no-acl) NOACL=1 ;;
    *) echo "usage: $0 [--dry-run] [--enable] [--no-acl]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
CODE=/opt/workbench/briefing-table
DATA=/var/lib/workbench
FILES=/var/lib/workbench-files
ETC=/etc/workbench
AGENT_HOME=/home/wbagent
BROKER_PORT=8301

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "would: $*"; else "$@"; fi; }
note() { say "  $1: ${*:2}"; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
if [ "$NOACL" != 1 ] && ! command -v setfacl >/dev/null 2>&1; then
  echo "setfacl not found: apt install acl (the shared scratch folder needs it), or pass --no-acl and accept that the engine cannot edit files an agent created there" >&2; exit 1
fi
[ -d "$CODE/node_modules" ] || { echo "$CODE/node_modules is missing: install the engine and run npm ci first" >&2; exit 1; }

# 1. accounts ------------------------------------------------------------------------------------------------------------
say "accounts"
if ! getent group wbagent >/dev/null; then run groupadd --system wbagent; note wbagent group created; else note wbagent group unchanged; fi
if ! id wbagent >/dev/null 2>&1; then
  run useradd --create-home --home-dir "$AGENT_HOME" --shell /bin/bash --gid wbagent wbagent; note wbagent "user created"
else note wbagent "user unchanged"; fi
if ! id wbengine >/dev/null 2>&1; then
  run useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin --user-group wbengine; note wbengine "user created"
else note wbengine "user unchanged"; fi

# 2. directories ---------------------------------------------------------------------------------------------------------
say "directories and modes"
mk() { # mk <mode> <owner:group> <path>
  if [ "$DRY" = 1 ]; then say "would: install -d -m $1 -o ${2%%:*} -g ${2##*:} $3"; else install -d -m "$1" -o "${2%%:*}" -g "${2##*:}" "$3"; fi
}
# The engine's data (identity database, tokens, mapping.db) is wbengine-only: agents cannot even traverse it.
mk 0700 wbengine:wbengine "$DATA"
mk 0700 wbengine:wbengine "$DATA/data"
mk 0700 wbengine:wbengine "$DATA/secrets"
# The person's FILES folder (HARBOR_WB_FILES_DIR, required by the hosted profile and kept apart from the data dir): per-room notes, assets and
# files live under <files>/rooms/<room>/. The engine and the room's agents both work in it. setgid keeps the group on new files.
mk 2770 wbengine:wbagent "$FILES"
# Files an agent creates there get mode 0640 (the broker's UMask is 0027), so the engine could read but not edit them. A default ACL
# gives both accounts rwx on everything created below this folder, whoever makes it. Without `setfacl` the folder still works, but
# the person cannot edit agent-made files through the engine; install the `acl` package to fix that.
if [ "$NOACL" != 1 ]; then
  if [ "$DRY" = 1 ]; then say "would: setfacl -R -m g:wbagent:rwx,g:wbengine:rwx and default entries on $FILES"; else
    setfacl -R -m g:wbagent:rwx,g:wbengine:rwx "$FILES"
    setfacl -R -d -m g:wbagent:rwx,g:wbengine:rwx "$FILES"
    note files "ACL set on $FILES (both accounts rwx, inherited)"
  fi
else
  note files "no ACL (--no-acl): files an agent creates here are read-only to the engine"
fi
mk 0755 root:root "$ETC"
mk 0750 wbagent:wbagent "$AGENT_HOME/dev"

# 3. tokens and env files ------------------------------------------------------------------------------------------------
say "secrets"
TOKEN_FILE="$DATA/secrets/broker.token"
if [ -s "$TOKEN_FILE" ]; then
  note broker.token "kept (already present)"
else
  if [ "$DRY" = 1 ]; then say "would: write a fresh 48-hex broker token to $TOKEN_FILE (0640 wbengine:wbagent)"; else
    umask 0137
    openssl rand -hex 24 > "$TOKEN_FILE"
    chown wbengine:wbagent "$TOKEN_FILE"; chmod 0640 "$TOKEN_FILE"
  fi
  note broker.token "created"
fi
# The broker token is readable by wbagent on purpose (the broker runs as it; its own agents could read it anyway). The ENGINE
# token and identity database stay wbengine-only, under $DATA/secrets and $DATA/data (0700).

# The one target a seat launches on: this server, through the local broker (the engine's own link to wbagent's broker).
TARGETS="$DATA/targets.json"
if [ -s "$TARGETS" ]; then note targets.json "kept"; else
  if [ "$DRY" = 1 ]; then say "would: write $TARGETS (wbengine 0600): one local target, shell /bin/bash"; else
    umask 0177
    printf '%s\n' '{ "targets": [ { "id": "local", "label": "This server", "kind": "local", "broker": "local", "shell": "/bin/bash", "node": "workbench-pilot" } ] }' > "$TARGETS"
    chown wbengine:wbengine "$TARGETS"; chmod 0600 "$TARGETS"; note targets.json "created"
  fi
fi

write_env() { # write_env <path> <content-from-stdin>
  local path="$1" tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then note "$path" "unchanged"; rm -f "$tmp"; return; fi
  if [ -f "$path" ] && [ "${FORCE_ENV:-0}" != 1 ]; then note "$path" "exists and differs: left alone (FORCE_ENV=1 to overwrite)"; rm -f "$tmp"; return; fi
  if [ "$DRY" = 1 ]; then say "would: write $path (root:root 0600)"; rm -f "$tmp"; return; fi
  install -m 0600 -o root -g root "$tmp" "$path"; rm -f "$tmp"; note "$path" "written"
}
if [ "$DRY" = 1 ] && [ ! -s "$TOKEN_FILE" ]; then BTOK="<new token>"; else BTOK="$(cat "$TOKEN_FILE" 2>/dev/null || echo '<new token>')"; fi
write_env "$ETC/pty-broker.env" <<ENV
PTY_BROKER_HOST=127.0.0.1
PTY_BROKER_PORT=$BROKER_PORT
PTY_BROKER_TOKEN=$BTOK
ENV
if [ -f "$ETC/workbench.env" ]; then note "$ETC/workbench.env" "kept"; else
  if [ "$DRY" = 1 ]; then say "would: copy workbench.env.example to $ETC/workbench.env (root:root 0600); edit the CHANGE-ME lines"; else
    install -m 0600 -o root -g root "$HERE/workbench.env.example" "$ETC/workbench.env"; note "$ETC/workbench.env" "written from the example: EDIT the CHANGE-ME lines"; fi
fi

# The built web app must be installed by the deployer; warn (do not fail) when it is not there.
APP_DIR="$(sed -n 's/^HARBOR_WB_APP_DIR=//p' "$ETC/workbench.env" 2>/dev/null | head -1)"; APP_DIR="${APP_DIR:-/opt/workbench/web-app}"
if [ -d "$APP_DIR/modules" ]; then note web-app "found at $APP_DIR"; else note web-app "NOT FOUND at $APP_DIR (no modules/): install the built app there, or /app and the bundled modules will be empty"; fi

# 4. units ---------------------------------------------------------------------------------------------------------------
say "systemd units"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node is not on PATH: install Node 22 first" >&2; exit 1; }
NODE_BIN="$(readlink -f "$NODE_BIN")"
for u in workbench-broker workbench-engine; do
  rendered="$(mktemp)"; sed "s|@NODE@|$NODE_BIN|g" "$HERE/$u.service" > "$rendered"
  if [ -f "/etc/systemd/system/$u.service" ] && cmp -s "$rendered" "/etc/systemd/system/$u.service"; then note "$u.service" "unchanged"
  else run install -m 0644 "$rendered" "/etc/systemd/system/$u.service"; note "$u.service" "installed (node: $NODE_BIN)"; fi
  rm -f "$rendered"
done
run systemctl daemon-reload
if [ "$ENABLE" = 1 ]; then run systemctl enable --now workbench-broker.service workbench-engine.service; else
  say "not enabled. When $ETC/workbench.env is edited: systemctl enable --now workbench-broker workbench-engine"; fi
say "done."
