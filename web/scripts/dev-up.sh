#!/usr/bin/env bash
# Brings up the Base Sepolia dev fixture.
#
# Start order: ethos stub, Next, blocking relay pass, relay loop, indexer pass.
# The relay pass must precede the indexer so gated KPI ceilings exist before reports.
#
# Usage: ./scripts/dev-up.sh          (or: pnpm dev:up)
#        ./scripts/dev-up.sh --down   (or: pnpm dev:down)
set -u
cd "$(dirname "$0")/.."

DOWN=0
if [ "${1:-}" = "--down" ]; then DOWN=1; shift; fi

REPO_ROOT="$(cd .. && pwd)"
LOGS="${TMPDIR:-/tmp}/boney-dev"
# One recorded process-group ID per child.
PGDIR="$LOGS/pgid"
mkdir -p "$PGDIR"
HERE="$(pwd -P)"

# Publicnode is the stable Base Sepolia default.
RPC="${RPC:-$(command grep -E '^NEXT_PUBLIC_BASE_SEPOLIA_RPC=' .env.local 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ')}"
RPC="${RPC:-https://base-sepolia-rpc.publicnode.com}"
INTERVAL="${INTERVAL:-120}"
PLAYGROUND="${PLAYGROUND:-0}"
if [ "$PLAYGROUND" = 1 ]; then
  RPC="${NEXT_PUBLIC_ANVIL_PLAYGROUND_RPC:-http://127.0.0.1:8546}"
fi

# Next permits one dev server per directory.
# `PORT=3001 ./scripts/dev-up.sh` moves the app when 3000 is occupied.
PORT="${PORT:-3000}"

# Reads a dotenv value without sourcing the file.
from_env_file() { # from_env_file <file> <var>
  [ -f "$1" ] || return 1
  local line
  line=$(command grep -E "^\s*$2\s*=" "$1" | tail -1) || return 1
  printf '%s' "$line" | cut -d= -f2- | tr -d '"'"'"' ' | command grep -q . || return 1
  printf '%s' "$line" | cut -d= -f2- | tr -d '"'"'"' '
}

# Resolves the reporter key from process env, then the repo-root dotenv file.
# Without a key, relay and indexer orchestration are skipped.
RELAYER_KEY="${REPORTER_PRIVATE_KEY:-${BONEY_RELAYER_KEY:-$(from_env_file "$REPO_ROOT/.env" REPORTER_PRIVATE_KEY || true)}}"

PIDS=()
REAPED=0

# Uses the child-reported process-group ID because `setsid` may fork.
start() { # start <name> <logfile> <cmd...>
  local name="$1" log="$2"; shift 2
  local pgfile i=0
  pgfile="$PGDIR/$(printf '%s' "$name" | tr -cs 'a-zA-Z0-9' '-')"
  echo "starting $name  (log: $log)"
  rm -f "$pgfile"
  setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "$pgfile" "$@" >"$log" 2>&1 &
  local bang=$! pg=""
  while [ ! -s "$pgfile" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1; done
  pg="$(cat "$pgfile" 2>/dev/null)"
  PIDS+=("${pg:-$bang}")
}

# True while any recorded group still has a member.
groups_alive() {
  local p
  for p in "${PIDS[@]:-}"; do kill -0 -- "-$p" 2>/dev/null && return 0; done
  return 1
}

# Terminates each recorded process group, then removes its record.
cleanup() {
  echo
  echo "shutting down…"
  local p i=0
  for p in "${PIDS[@]:-}"; do kill -- "-$p" 2>/dev/null; done
  while [ "$i" -lt 20 ] && groups_alive; do i=$((i + 1)); sleep 0.25; done
  for p in "${PIDS[@]:-}"; do kill -9 -- "-$p" 2>/dev/null; done
  rm -f "$PGDIR"/* 2>/dev/null
  wait 2>/dev/null
}

waitfor() { # waitfor <name> <url> <seconds>
  local name="$1" url="$2" limit="$3" i=0
  while [ "$i" -lt "$limit" ]; do
    if curl -sf -o /dev/null "$url"; then echo "  $name ready"; return 0; fi
    i=$((i + 1)); sleep 1
  done
  echo "  $name did NOT come up within ${limit}s — check its log" >&2
  return 1
}

# Reap the current directory only; other projects may run matching commands.
STRAY_PAT='next dev|next-server|relay-loop\.sh|relay-kpi-metric\.ts|ethos-stub-dev\.ts|scripts/indexer\.ts'

strays_here() {
  local p a mine=" $$ " hops=0
  a="$$"
  while [ "$hops" -lt 20 ]; do
    hops=$((hops + 1))
    a="$(awk '/^PPid:/{print $2}' "/proc/$a/status" 2>/dev/null)"
    case "$a" in "" | 0 | 1) break ;; esac
    mine="$mine$a "
  done
  for p in $(pgrep -f "$STRAY_PAT" 2>/dev/null); do
    case "$mine" in *" $p "*) continue ;; esac
    [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$HERE" ] || continue
    printf '%s\n' "$p"
  done
}

reap_strays() {
  REAPED=0
  local f pg p

  for f in "$PGDIR"/*; do
    [ -f "$f" ] || continue
    pg="$(cat "$f" 2>/dev/null)"
    rm -f "$f"
    case "$pg" in "" | *[!0-9]*) continue ;; esac
    kill -0 -- "-$pg" 2>/dev/null || continue
    kill -- "-$pg" 2>/dev/null && REAPED=$((REAPED + 1))
  done

  for p in $(strays_here); do
    kill "$p" 2>/dev/null && REAPED=$((REAPED + 1))
  done

  [ "$REAPED" -eq 0 ] && return 0
  echo "reaped $REAPED leftover process(es) from a previous run"
  sleep 1
  for p in $(strays_here); do kill -9 "$p" 2>/dev/null; done
}

if [ "$DOWN" = 1 ]; then
  reap_strays
  [ "$REAPED" -eq 0 ] && echo "nothing running from this directory."
  exit 0
fi

trap cleanup EXIT INT TERM

# ---- 0. reap a previous run ----------------------------------------------------------------------
# `NO_REAP=1` preserves deliberately running matching processes.
[ -n "${NO_REAP:-}" ] || reap_strays

# ---- 1. ethos stub -------------------------------------------------------------------------------
start "ethos stub" "$LOGS/ethos-stub.log" pnpm ethos:stub:dev
waitfor "ethos stub" "http://127.0.0.1:8787/health" 30 || exit 1

# ---- 2. next dev ---------------------------------------------------------------------------------
start "next dev" "$LOGS/next-dev.log" pnpm dev --port "$PORT"
waitfor "next dev" "http://localhost:$PORT/" 90 || exit 1

# ---- 3. relay, then 4. indexer -------------------------------------------------------------------
if [ "$PLAYGROUND" = 1 ]; then
  echo
  echo "Playground mode — skipping Base Sepolia relay and indexer orchestration."
elif [ -n "$RELAYER_KEY" ]; then
  export REPORTER_PRIVATE_KEY="$RELAYER_KEY"
  echo "relay: first pass (blocking — the indexer must not report before this lands)…"
  RPC="$RPC" ./scripts/relay-loop.sh --once | tee "$LOGS/relay-once.log"
  # Do not retain a dead relay-loop PID for an empty target list.
  if command grep -q 'no gated KPIs' "$LOGS/relay-once.log"; then
    echo "  not starting the relay loop — nothing to relay."
  else
    start "relay loop" "$LOGS/relay-loop.log" env RPC="$RPC" REPORTER_PRIVATE_KEY="$RELAYER_KEY" \
      ./scripts/relay-loop.sh "$INTERVAL"
  fi

  echo "indexer: one pass…"
  pnpm index --rpc "$RPC" 2>&1 | command grep -vE 'scanning [0-9]+/|reading [0-9]+/' || true
else
  echo
  echo "No relayer key found — skipping relay + indexer."
  echo "  Looked at: \$REPORTER_PRIVATE_KEY, \$BONEY_RELAYER_KEY, $REPO_ROOT/.env"
  echo "  The app is fully usable, but no campaign progress is reported."
  echo "  To enable, add to $REPO_ROOT/.env:   REPORTER_PRIVATE_KEY=0x..."
fi

echo
echo "up:  app http://localhost:$PORT   stub http://127.0.0.1:8787"
echo "logs: $LOGS"
echo "Ctrl-C to stop everything, or \`pnpm dev:down\` from another shell."
wait
