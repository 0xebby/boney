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
# Only the **gated** KPIs belong here. Relaying an ungated one is pointless: with `verifier == 0x0` the
# campaign credits the reported figure as-is, so there is no ceiling to raise. Venus, Sdy Labs and
# SuperBridge are ungated throughout and never belong here; Gyndore gates all three of its KPIs, so its
# three entries are the whole list. The empty-list branch below stays for a fixture reseed, where a
# stale address must be removed before the new one exists.
#
# Addresses change with every `DeployBoney` + reseed, and a stale one is silent: the relayer reports
# against a dead campaign, credits nothing, and the gated KPI simply stays flat.
#
# Keep any KPI that watches the escrow token *out* of this list. Its `Transfer` events include things
# that are not user actions — the referral's own self-transfers, tier payouts leaving the EscrowVault,
# the Boney facade moving tokens — and the payout case is self-reinforcing, since a payout raises the
# observed ceiling, which unlocks the next tier, which pays out again. Gyndore pays in GYND and no
# Gyndore KPI watches GYND's `Transfer`, so its three are safe to list.
TARGETS=(
  # Gyndore Testnet, seeded 2026-08-31: swaps, GYND stakes, LP mints.
  0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc:0
  0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc:1
  0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc:2
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  printf '[%s] no gated KPIs to relay — none are listed in TARGETS.\n' "$(date -u +%H:%M:%S)"
  exit 0
fi

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
