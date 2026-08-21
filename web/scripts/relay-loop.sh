#!/usr/bin/env bash
# Runs `pnpm relay` over every gated KPI on a cycle.
#
# The relayer is an off-chain process, not a contract — nothing on chain wakes up and scans logs, so a
# gated KPI's ceiling stays at 0 until this has run. A report that lands first succeeds and credits
# nothing, with no revert to surface it. This is the "just press the button" prerequisite.
#
# Each cycle costs at most one transaction per KPI: `reportBatch` when there is creditable activity,
# `advanceCheckpoint` when there are new blocks but nothing creditable, and nothing at all when no new
# blocks have appeared. On Base's 2s blocks the middle case is the common one.
#
# Usage: RPC=<url> ./scripts/relay-loop.sh [--once] [interval_seconds]
#
# `--once` runs a single pass and exits, which is what `dev-up.sh` needs: the indexer must not report
# before the ceiling has been raised, so startup blocks on one synchronous pass and only then leaves a
# loop running behind it. It lives here rather than in `dev-up.sh` so the target list has one home.
set -u
ONCE=0
if [ "${1:-}" = "--once" ]; then ONCE=1; shift; fi
RPC="${RPC:-https://base-sepolia-rpc.publicnode.com}"
INTERVAL="${1:-120}"

# campaign:kpiIndex.
#
# These are the whole fixture as of the 2026-08-21 redeploy — two campaigns, both watching a real
# third-party protocol. Addresses change with every `DeployBoney` + reseed, and a stale one is silent:
# the relayer reports against a dead campaign, credits nothing, and the gated KPI simply stays flat.
#
# The escrow-token campaign that used to be excluded here is gone with the old fixture. If one is ever
# seeded again, keep it out: its KPI watched the escrow token, so `Transfer` events that are not user
# actions got credited — the referral's own self-transfers, tier payouts arriving from the EscrowVault,
# and the Boney facade moving tokens. The payout case is self-reinforcing, since a payout raises the
# observed ceiling, which unlocks the next tier, which pays out again.
TARGETS=(
  "0x5A6d0E8CF9df181d62Cd2D8608c93d9328678985:0"   # Aave Supplies — real Aave pool
  "0x6225448466f97d795f363951606B5A22A93241d9:0"   # Sygma Bridge  — real bridge
)

while true; do
  for t in "${TARGETS[@]}"; do
    c="${t%%:*}"; k="${t##*:}"
    out=$(pnpm relay --campaign "$c" --kpi "$k" --rpc "$RPC" 2>&1)
    # Match an address followed by `old → new`. The looser "contains an arrow" test is wrong: the
    # relayer prints `scanning: <from> → <to>` on every cycle that has new blocks, so it reported a
    # credit every time.
    credited=$(printf '%s' "$out" | command grep -E '0x[0-9a-fA-F]{40}: [0-9]+ → [0-9]+')
    if [ -n "$credited" ]; then
      printf '[%s] %s kpi %s CREDITED: %s\n' "$(date -u +%H:%M:%S)" "${c:0:10}" "$k" \
        "$(printf '%s' "$credited" | tr -s ' \n' ' ')"
    elif printf '%s' "$out" | command grep -qE "done — checkpoint now at"; then
      : # checkpoint advanced, nothing creditable — the quiet common case
    elif printf '%s' "$out" | command grep -qE "nothing new to scan"; then
      :
    else
      printf '[%s] %s kpi %s PROBLEM: %s\n' "$(date -u +%H:%M:%S)" "${c:0:10}" "$k" \
        "$(printf '%s' "$out" | tail -3 | tr -s ' \n' ' ')"
    fi
  done
  [ "$ONCE" = 1 ] && break
  sleep "$INTERVAL"
done
