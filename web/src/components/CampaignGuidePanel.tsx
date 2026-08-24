"use client";

import {Card, CardHeader} from "@/components/ui/Card";
import {CampaignGuideEditor} from "@/components/CampaignGuideEditor";
import {useTrackedEvent} from "@/hooks/useTrackedEvent";
import {explorerAddressUrl} from "@/lib/chains";
import {guideForKpi, linkLabel, type ResolvedGuide} from "@/lib/campaignGuide";
import {describeUnit} from "@/lib/kpiUnits";
import {KPI_KIND_LABEL} from "@/lib/types";
import {shortAddress} from "@/lib/format";
import type {ViewerRole} from "@/lib/viewerRole";
import type {CampaignDetail, KpiDetail} from "@/lib/campaignDetail";

/**
 * What a reader is supposed to *do* about this campaign.
 *
 * ## The gap this fills
 *
 * A referral arrives here straight from `/r`, having just signed a touch that makes their next action
 * credit a promoter — and `visibleSections("referral")` correctly hides the reward ladders, the escrow
 * tiles, the utilization meter and the escrow return from them, because none of it describes anything
 * they can earn. What was left was the campaign's name, its pool size, and a closing time. The page
 * never said which action counts, or where to perform it.
 *
 * ## Why it renders for a campaign with no guide at all
 *
 * Because most of the answer is already on chain. `useTrackedEvent` decodes each KPI's watched contract
 * out of `KpiSpec.params` and names both it and the event in words, so every campaign gets a real "go
 * here" destination — the contract's own explorer page — with nothing supplied at creation. The
 * project's prose is an upgrade on that, not a precondition for it. The section is withheld only when
 * there is neither a guide nor a single event-sourced KPI, which is a campaign the project reports by
 * hand and where there is genuinely nothing to point at.
 *
 * ## Outbound links
 *
 * Every URL here has been through `safeExternalUrl` (https only, no credentials in the authority) and
 * every anchor states its hostname, because a link labelled "Open the app" on a page that just
 * established trust is the most clickable thing on the screen. A `provenance: "project"` guide says out
 * loud that its links came from the project's key and that Boney has not vetted them; the committed
 * catalog carries no URLs at all, so it makes no such claim to qualify. See `lib/campaignGuide`.
 */
export function CampaignGuidePanel({
  detail,
  guide,
  chainId,
  role,
  onGuidePublished,
}: {
  detail: CampaignDetail;
  guide: ResolvedGuide | null;
  /** Resolves the block explorer; absent on local chains, where the address renders as plain text. */
  chainId?: number;
  /** Words the subtitle, and decides whether the editor is offered. The panel itself is shown to all. */
  role: ViewerRole;
  /** Re-read the store after the project publishes. */
  onGuidePublished: () => void;
}) {
  return (
    <Card>
      <CardHeader title="How to take part" subtitle={subtitleFor(role)} />

      {guide?.summary ? (
        <p className="text-xs leading-relaxed text-ink-secondary">{guide.summary}</p>
      ) : null}

      {guide?.siteUrl ? (
        <p className="mt-2 text-xs">
          <ExternalLink href={guide.siteUrl} label={linkLabel(guide.siteUrl)} />
        </p>
      ) : null}

      <ul className="mt-3 space-y-2.5 border-t border-hairline pt-3">
        {detail.kpis.map((kpi) => (
          <KpiRow
            campaign={detail.address}
            campaignName={detail.name}
            chainId={chainId}
            guide={guide}
            key={kpi.index}
            kpi={kpi}
          />
        ))}
      </ul>

      {/*
        Said once, at the foot, rather than beside each link — repeating it per row would read as a
        warning about that specific destination rather than about where the whole set came from.
      */}
      {guide?.provenance === "project" ? (
        <p className="mt-3 text-[11px] text-ink-muted">
          Supplied by this campaign&rsquo;s project wallet. Boney does not vet these links — check
          where one goes before signing anything.
        </p>
      ) : null}

      {/*
        Everything on chain is immutable — `CampaignConfig`, every `KpiSpec`, every tier are fixed in the
        constructor — so the guide is the one part of a campaign its project can still correct. Offering
        that only on the create page's confirmation screen would have made a mistyped link permanent.

        Not a permission: the route checks a signature against `Campaign.project()`, so this only decides
        who is shown the form. See `CampaignGuideEditor`.
      */}
      {role === "project" ? (
        <CampaignGuideEditor
          campaign={detail.address}
          guide={guide}
          kpis={detail.kpis}
          onPublished={onGuidePublished}
        />
      ) : null}
    </Card>
  );
}

/**
 * Whether this panel has anything to say.
 *
 * Lives beside the panel rather than inside it because the campaign page decides layout: an empty
 * `Card` still draws a border and a heading, so the caller has to know before it mounts one.
 *
 * A KPI contributes as soon as it declares an event source, which is what `decodeEventSource` returning
 * non-null means. That is checked through `useTrackedEvent` in the row itself, so this uses the cheaper
 * proxy available to a pure function: `params` longer than `"0x"`. A KPI whose params hold a
 * `TouchWindowVerifier` lookback rather than an event source passes this and then renders without a
 * link, which is the harmless direction to be wrong in — one row saying only what the KPI measures.
 *
 * `role` is the exception that keeps the panel from being unreachable: a project whose campaign has
 * neither a guide nor an event-sourced KPI is exactly the project that needs the editor, and withholding
 * the section would leave it no way to write one.
 */
export function hasGuideContent(
  detail: CampaignDetail,
  guide: ResolvedGuide | null,
  role: ViewerRole,
): boolean {
  if (role === "project") return true;
  return guide !== null || detail.kpis.some((kpi) => kpi.spec.params.length > 2);
}

function subtitleFor(role: ViewerRole): string {
  switch (role) {
    case "referral":
      // They have just signed a touch, so the useful frame is "your next action counts".
      return "You are attributed on this campaign — these are the actions that credit your promoter";
    case "promoter":
    case "visitor":
      return "What your referrals need to do, and where they do it";
    case "project":
      return "What this campaign asks of a referred user";
    case "disconnected":
      return "What this campaign measures, and where those actions happen";
  }
}

/**
 * One KPI: what it measures, the project's instruction for it, and somewhere to go.
 *
 * `useTrackedEvent` is the same hook `KpiPanel` uses, at `staleTime: Infinity` and keyed on
 * `(chain, campaign, kpiIndex)` — so a KPI mounted in both places is one fetch, not two, and this panel
 * adds no reads to a page that already renders the ladders.
 */
function KpiRow({
  campaign,
  campaignName,
  chainId,
  guide,
  kpi,
}: {
  campaign: `0x${string}`;
  campaignName?: string;
  chainId?: number;
  guide: ResolvedGuide | null;
  kpi: KpiDetail;
}) {
  const {tracked} = useTrackedEvent({
    campaign,
    campaignName,
    kind: kpi.spec.kind,
    kpiIndex: kpi.index,
    params: kpi.spec.params,
    verifier: kpi.spec.verifier,
  });

  const entry = guideForKpi(guide, kpi.index);
  /*
    Where the row sends a reader: the project's own link when it supplied one, the watched contract's
    explorer page otherwise.

    One destination, not two. The explorer page is a fallback rather than a companion — a project that
    has a real UI for this action knows better than we do where the action happens, and putting a second
    link beside theirs would make the reader choose between them without telling them how.

    `tracked === null` means the KPI declares no event source at all, so there is no contract to fall
    back to and the row says so instead of linking nowhere.
  */
  const projectUrl = entry?.url;
  const explorer =
    projectUrl || tracked === null || chainId === undefined
      ? undefined
      : explorerAddressUrl(chainId, tracked.contract);

  return (
    <li>
      <p className="text-xs font-medium text-ink">
        {KPI_KIND_LABEL[kpi.spec.kind]}
        {/* The contract, named in words where anything on chain names it — see `lib/eventNames`. */}
        {tracked && tracked.protocolFrom !== "address" ? (
          <span className="font-normal text-ink-muted"> · on {tracked.protocol}</span>
        ) : null}
      </p>

      {entry?.action ? (
        <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">{entry.action}</p>
      ) : null}

      {/*
        What one unit of progress costs, for the reader who most needs it and is least likely to see
        it elsewhere: `visibleSections("referral")` hides the KPI panel and its ladders, so this row
        is where an attributed referral learns that ten wraps buy one unit. Neutral — the same
        sentence for a well-configured KPI as for the lynx campaign's, no misconfiguration flag on a
        campaign already on chain. See `lib/kpiUnits`.
      */}
      {tracked ? (
        <p className="mt-0.5 text-[11px] text-ink-muted">
          {describeUnit({
            amountMode: tracked.amountMode,
            kind: kpi.spec.kind,
            scale: tracked.scale,
            signature: tracked.eventFrom === "kind" ? undefined : tracked.event,
            token: tracked.token,
          })}
        </p>
      ) : null}

      <p className="mt-1 text-xs">
        {projectUrl ? (
          <ExternalLink href={projectUrl} label={linkLabel(projectUrl)} />
        ) : explorer ? (
          <ExternalLink href={explorer} label="Contract on the explorer" />
        ) : tracked ? (
          // A chain with no explorer in the table — anvil. The address is still the useful fact.
          <span className="font-mono text-ink-muted">{shortAddress(tracked.contract)}</span>
        ) : (
          <span className="text-ink-muted">
            Reported by the project — no public contract to watch.
          </span>
        )}
      </p>
    </li>
  );
}

/**
 * An outbound link that says where it goes.
 *
 * `noopener` alongside `noreferrer`: modern browsers imply the former from `target="_blank"`, but this
 * is the one place in the app that renders a URL a stranger supplied, so it is spelled out rather than
 * inherited from a default that could change.
 */
function ExternalLink({href, label}: {href: string; label: string}) {
  return (
    <a
      className="text-brand underline hover:text-ink"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {label} <span aria-hidden>↗</span>
    </a>
  );
}
