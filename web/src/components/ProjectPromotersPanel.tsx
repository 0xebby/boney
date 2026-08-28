"use client";

import {useMemo} from "react";
import Link from "next/link";
import {useCampaignPromoters} from "@/hooks/useCampaignPromoters";
import {useCampaignSettlements} from "@/hooks/useCampaignSettlements";
import {Card, CardHeader} from "@/components/ui/Card";
import {DataTable, type Column} from "@/components/ui/DataTable";
import {StatTile, StatRow} from "@/components/ui/StatTile";
import {EmptyState, ErrorState, SkeletonRows} from "@/components/ui/States";
import {
  buildPromoterRows,
  countOrphanPayouts,
  totalPaid,
  unaccountedPaid,
  type PromoterRow,
} from "@/lib/settlements";
import {explorerAddressUrl} from "@/lib/chains";
import {cardLink} from "@/lib/publicCard";
import {formatTokenAmount, formatPercent, shortAddress} from "@/lib/format";
import type {CampaignDetail} from "@/lib/campaignDetail";
import type {CampaignView} from "@/lib/types";

/**
 * The project's own view of its campaign: who joined, and what each has been paid.
 *
 * This replaces the reward-ladder panels for the owner (see `lib/viewerRole`). The ladders are the
 * numbers the owner set at creation and can read back off the create form; what no other screen
 * offers is the other side of the arrangement — which wallets took the campaign up, and where the
 * escrow actually went.
 *
 * Both halves are log scans (`PromoterJoined`, `TierSettled`) because `Campaign` stores neither list.
 * That means a floor: public RPCs cap a `getLogs` range and the scan caps its window count, so a long
 * history is covered from the most recent span backwards. Every number below is therefore checked
 * against `paidOut`, which the contract does store, and any gap is stated rather than absorbed — an
 * owner reconciling payouts against a bank balance is exactly the reader a quietly short total would
 * mislead.
 */
export function ProjectPromotersPanel({
  view,
  detail,
  token,
  chainId,
}: {
  /** The campaign row — `useCampaignPromoters` scans by view, not by address. */
  view: CampaignView;
  detail: CampaignDetail;
  token: {symbol: string; decimals: number};
  /** Resolves each promoter's destination — their BoneyCard, or the block explorer. */
  chainId?: number;
}) {
  const directory = useCampaignPromoters([view]);
  const settlements = useCampaignSettlements(detail.address);

  const promoters = useMemo(() => directory.groups[0]?.promoters ?? [], [directory.groups]);
  const rows = useMemo(
    () => buildPromoterRows(promoters, settlements.payouts),
    [promoters, settlements.payouts],
  );

  const folded = totalPaid(settlements.payouts);
  const unaccounted = unaccountedPaid(detail.paidOut, settlements.payouts);
  const orphans = countOrphanPayouts(promoters, settlements.payouts);
  const earning = rows.filter((r) => r.paid > BigInt(0)).length;

  const busy = directory.isLoading || settlements.isLoading;
  const error = directory.error ?? settlements.error;

  // Percentages read against what was actually observed, not against `paidOut`: dividing by a total
  // the rows do not add up to would make the column sum to less than 100% with no explanation.
  const columns = useMemo(
    () => buildColumns(token, folded, chainId),
    [token, folded, chainId],
  );

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-bold text-brand">Promoters</h2>

      <StatRow>
        <StatTile
          label="Promoters joined"
          value={busy ? "—" : rows.length.toLocaleString("en-US")}
          qualifier={busy || rows.length === 0 ? undefined : `${earning} earning`}
        />
        <StatTile
          label="Paid to promoters"
          value={formatTokenAmount(detail.paidOut, token.decimals, {compact: true})}
          unit={token.symbol}
          qualifier={`of ${formatTokenAmount(detail.rewardPool, token.decimals, {compact: true})}`}
        />
        <StatTile
          label="Still escrowed"
          value={formatTokenAmount(detail.escrowBalance, token.decimals, {compact: true})}
          unit={token.symbol}
          hint="what the vault holds"
        />
      </StatRow>

      <Card padded={false}>
        <div className="p-4 pb-0">
          <CardHeader
            title="Payouts by promoter"
            subtitle="Amounts released by crossed tiers, read from the campaign's own settlement events"
          />
        </div>

        {busy ? (
          <SkeletonRows rows={3} cols={5} />
        ) : error ? (
          <ErrorState
            message={String(error)}
            onRetry={() => {
              void directory.refetch();
              void settlements.refetch();
            }}
          />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.promoter.toLowerCase()}
            initialSort={{key: "paid", dir: "desc"}}
            isRefreshing={settlements.isRefreshing}
            emptyState={
              <EmptyState
                title="No promoters yet"
                description="Nobody has joined this campaign, so no rewards have been released."
              />
            }
          />
        )}
      </Card>

      <ScanNotes
        scannedFrom={directory.scannedFrom ?? settlements.scannedFrom}
        truncated={directory.truncated}
        unaccounted={unaccounted}
        orphans={orphans}
        decimals={token.decimals}
        symbol={token.symbol}
      />
    </section>
  );
}

function buildColumns(
  token: {symbol: string; decimals: number},
  observedTotal: bigint,
  chainId?: number,
): Column<PromoterRow>[] {
  return [
    {
      key: "promoter",
      header: "Promoter",
      sortValue: (r) => r.promoter.toLowerCase(),
      /*
        The wallet's own BoneyCard where there is one, and the block explorer otherwise.

        The card is the better destination for a project reading this table: it answers "who is this
        promoter" with their cumulative Boneyard history rather than with a token balance, and it carries
        the explorer link onward for anyone who wanted that instead. `cardLink` returns undefined off the
        chain the card serves — see `lib/publicCard` — which is when the explorer is all there is.
      */
      render: (r) => {
        const card = cardLink(r.promoter, chainId);
        if (card) {
          return (
            <Link href={card} className="font-mono text-ink hover:underline">
              {shortAddress(r.promoter)}
            </Link>
          );
        }
        const href = chainId === undefined ? undefined : explorerAddressUrl(chainId, r.promoter);
        return href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-ink hover:underline"
          >
            {shortAddress(r.promoter)}
          </a>
        ) : (
          <span className="font-mono text-ink">{shortAddress(r.promoter)}</span>
        );
      },
    },
    {
      key: "reputation",
      header: "Score at join",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.reputation,
      /*
        The BoneyScore `Campaign.join` read at the time, which is what the reputation gate was
        checked against — not today's score. Reads 0 for a wallet that had no reputation record
        then, which is a fact about that moment rather than a failed lookup, so the header says
        "at join" instead of implying it is current.
      */
      render: (r) => r.reputation.toLocaleString("en-US"),
    },
    {
      key: "tiers",
      header: "Tiers paid",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.tiers,
      render: (r) =>
        r.tiers === 0 ? <span className="text-ink-muted">—</span> : r.tiers.toLocaleString("en-US"),
    },
    {
      key: "paid",
      header: "Paid",
      numeric: true,
      sortValue: (r) => r.paid,
      render: (r) =>
        r.paid === BigInt(0) ? (
          <span className="text-ink-muted">nothing yet</span>
        ) : (
          <span>
            {formatTokenAmount(r.paid, token.decimals, {compact: true})}{" "}
            <span className="text-ink-muted">{token.symbol}</span>
          </span>
        ),
    },
    {
      key: "share",
      header: "Share",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.paid,
      render: (r) =>
        observedTotal === BigInt(0) ? (
          <span className="text-ink-muted">—</span>
        ) : (
          formatPercent(Number(r.paid), Number(observedTotal))
        ),
    },
  ];
}

/**
 * What the read could not see.
 *
 * Four separate admissions rather than one, because they have different fixes: a floor means look
 * further back, a truncated list means some members were never returned, a shortfall means the total
 * below is not the campaign's total, and an orphan payout means a promoter row is missing entirely.
 * Renders nothing when the read was complete, which is the normal case on a fixture younger than the
 * window budget.
 */
function ScanNotes({
  scannedFrom,
  truncated,
  unaccounted,
  orphans,
  decimals,
  symbol,
}: {
  scannedFrom?: bigint;
  truncated: boolean;
  unaccounted: bigint;
  orphans: number;
  decimals: number;
  symbol: string;
}) {
  if (scannedFrom === undefined && !truncated && unaccounted === BigInt(0) && orphans === 0) {
    return null;
  }

  return (
    <div className="space-y-1 text-xs">
      {scannedFrom !== undefined ? (
        <p className="text-ink-muted">
          History was scanned from block {scannedFrom.toLocaleString("en-US")} only — joins and
          payouts before that block are not in this table.
        </p>
      ) : null}

      {truncated ? (
        <p className="text-ink-muted">
          More promoters joined than one read returns, so some memberships are missing from the rows
          above.
        </p>
      ) : null}

      {unaccounted > BigInt(0) ? (
        <p className="text-warning">
          The campaign reports {formatTokenAmount(unaccounted, decimals, {compact: true})} {symbol}{" "}
          paid outside the scanned range, so the amounts below are a floor rather than the full
          total.
        </p>
      ) : null}

      {orphans > 0 ? (
        <p className="text-warning">
          {orphans} paid wallet{orphans === 1 ? "" : "s"} did not appear in the join scan, so
          {orphans === 1 ? " its" : " their"} payouts are missing from the rows above.
        </p>
      ) : null}
    </div>
  );
}
