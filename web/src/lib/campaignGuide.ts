import {baseSepolia, sepolia} from "viem/chains";
import type {ValidationIssue} from "./validation";

/**
 * The off-chain half of a campaign: what it is about, and what a referral is supposed to *do*.
 *
 * ## Why this is off chain at all
 *
 * `Types.CampaignConfig` is `(project, name, token, rewardPool, startTime, endTime,
 * attributionWindow, minReputation)` and `KpiSpec.params` is already spent on the event-source blob
 * (see `kpiSource.ts`). There is no slot for a sentence, and adding one would mean a redeploy of a
 * fixture that is live. So a guide is web-side data, and this module is the only place that decides
 * what a valid one looks like.
 *
 * ## What the page can already answer without a guide
 *
 * Most of it. `useTrackedEvent` resolves each KPI's watched contract and names both the contract and
 * the event in words, so **every campaign on chain today gets a working "go here" link with nothing
 * supplied at creation** — the contract's own block-explorer page. A guide adds the prose a chain
 * read cannot produce, and a destination that beats a raw contract: which of the contract's actions
 * counts, and where in the project's own UI to do it. One link per KPI either way — a `KpiGuide.url`
 * replaces the explorer link rather than sitting beside it, because a project with a real UI knows
 * better than we do where its action happens.
 *
 * ## Two sources, and why the catalog carries no URLs
 *
 * A stored guide (`guideStore.ts`, written by the project's own wallet through
 * `/api/campaign-guide`) beats `CATALOG`, which is committed and covers the five live fixture
 * campaigns from `script/SeedFive.s.sol`.
 *
 * Every catalog entry deliberately omits `url`. `knownContracts.ts` sets the bar for this file — an
 * entry is a *claim*, and a wrong one here is worse than a wrong label: it is an outbound link a
 * referral was invited to click. Aave's and Uniswap's testnet interfaces could not be verified from
 * this repo the way their contract addresses and event topics were, and a plausible-looking guess at
 * a market slug or a chain query param is exactly the kind of hand-copied value F4 exists to avoid.
 * So the catalog carries prose, which is checkable against the seed script, and lets the explorer
 * link stand. A project that has a real UI supplies it through the form, where it is signed for.
 *
 * Pure and React-free (decision F6), like `kpiSource.ts` and `eventNames.ts`: the URL rules are the
 * part that can be wrong, and `vitest.config.mts` runs a `node` environment over `src/**\/*.test.ts`,
 * so logic that lives here is provable by fixture while the panel stays thin enough not to need a DOM.
 */

// ── shape ────────────────────────────────────────────────────────

/** What a referral does to move one KPI, and where. */
export type KpiGuide = {
  /** Index into the campaign's KPI array — the same `KpiDetail.index` the panel renders. */
  kpiIndex: number;
  /** One line: the action that credits this KPI. */
  action?: string;
  /** The project's own UI for that action. Absent means the panel links the watched contract. */
  url?: string;
};

export type CampaignGuide = {
  /** What the campaign is about, in the project's words. */
  summary?: string;
  /** The project's app or site. */
  siteUrl?: string;
  kpis?: readonly KpiGuide[];
};

/**
 * Where a guide came from.
 *
 * Rendered, not just recorded: a `"project"` guide's links were supplied by whoever holds the
 * campaign's project key and are shown with that said out loud, because Boney does not vet them.
 */
export type GuideProvenance = "catalog" | "project";

export type ResolvedGuide = CampaignGuide & {provenance: GuideProvenance};

/**
 * Length caps.
 *
 * A panel, not a page. These are enforced on the way in (`sanitizeGuide`) rather than only warned
 * about, so a stored guide cannot push the campaign's own facts below the fold.
 */
export const MAX_SUMMARY_LENGTH = 280;
export const MAX_ACTION_LENGTH = 140;

// ── URLs ─────────────────────────────────────────────────────────

/**
 * A guide URL, or `undefined` when it is not one we will render.
 *
 * **This is the security boundary of the whole feature.** Everything else here is copy; this decides
 * what a referral's browser is invited to navigate to, on a page that just told them they are
 * attributed to someone. So it is an allowlist of one scheme rather than a blocklist of the bad ones:
 *
 *  - `javascript:` and `data:` are the obvious attacks and a blocklist would catch them, but it would
 *    also have to keep catching `vbscript:`, `blob:`, and whatever the next one is.
 *  - `http:` is rejected too, which is a real restriction rather than pedantry — a plain-HTTP link
 *    from an HTTPS page is a downgrade a referral has no way to notice.
 *
 * Returns the parsed href rather than the input, so the stored form is normalized and a caller cannot
 * accidentally render un-round-tripped text. Credentials in the authority (`https://user:pass@host`)
 * are refused outright: they render as a hostname that is not where the link goes, which defeats
 * `linkLabel` below.
 */
export function safeExternalUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not absolute, or not parseable at all. A relative path would resolve against Boney's own
    // origin, which is never what a project meant by "our app".
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;

  return url.href;
}

/**
 * The hostname to show beside a link, so a reader sees where it goes.
 *
 * An anchor whose text is "Open the app" tells a referral nothing about the destination, and this
 * panel's links come from a form. `www.` is dropped because it is noise; nothing else is, since the
 * point is fidelity rather than tidiness.
 *
 * Falls back to the raw string for anything unparseable, which `safeExternalUrl` should already have
 * rejected — this is the defensive branch, not a path callers take.
 */
export function linkLabel(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

// ── the committed catalog ────────────────────────────────────────

/** Lowercased campaign addresses, so a checksummed address from any source keys the same entry. */
type GuidesByCampaign = Readonly<Record<string, CampaignGuide>>;

/**
 * Base Sepolia's live fixture — the five campaigns `script/SeedFive.s.sol` creates, in the order it
 * creates them. Addresses read from `CampaignRegistry.campaignAt` on chain rather than from the
 * broadcast receipt, and every unit below is the `scale` the seed script actually passed.
 */
const BASE_SEPOLIA: GuidesByCampaign = {
  // id 0 — "Sygma Bridge". `_sygma`: gated bridge count, then WETH wrap volume at `MILLI`.
  "0x938e0c2ef6e3ed250d1d004050091f0a26076fec": {
    summary:
      "Bridge out of Base Sepolia through Sygma's generic-message handler. Wrapping ETH counts " +
      "too — it is the step before a bridge, and the amount bridged is not readable from the " +
      "event, so the second KPI measures the wrap instead.",
    kpis: [
      {
        action:
          "Make one bridge deposit to any destination domain. The fee is the only cost — the " +
          "handler's deposit is a view call, so no tokens move.",
        kpiIndex: 0,
      },
      {action: "Wrap ETH into WETH. One unit of progress per 0.001 ETH.", kpiIndex: 1},
    ],
  },
  // id 1 — "Aave". `_aave`: COUNT on both legs, because `Supply` puts the depositor's address where
  // the amount would be and `dataWord0` would credit progress equal to an address.
  "0x014e8499da2f401f9f0fc4785952c141b1ea6be4": {
    summary:
      "Supply and withdraw on Aave V3's Base Sepolia pool. Both legs count, and both are counted " +
      "rather than summed: the amount is not the first non-indexed word of either event, so the " +
      "number of actions is the only honest reading available.",
    kpis: [
      {action: "Supply any asset to the pool. One unit per supply, whatever the size.", kpiIndex: 0},
      {action: "Withdraw any asset back out. One unit per withdrawal.", kpiIndex: 1},
    ],
  },
  // id 2 — "Open Mint NFT". `_nft`: ERC-721 `Transfer` counted, then `Minted`'s `paid` at `MILLI`.
  "0x6dc20396480557e001ea986bd765d81a7279ded5": {
    summary:
      "A permissionlessly mintable ERC-721 this fixture deploys itself — Base Sepolia has no " +
      "collection with an open mint, so there was nothing third-party to point at. No allowlist " +
      "and no phase: paying the mint price is the only requirement.",
    kpis: [
      {action: "Mint at least one token. One unit per token minted.", kpiIndex: 0},
      {action: "The same mints, measured by spend. One unit per 0.001 ETH paid.", kpiIndex: 1},
    ],
  },
  // id 3 — "WETH". `_weth`: one `Deposit` event read as volume and as a count, plus the unwrap.
  "0x5c42acdaff94b3d15d48ebf76c9a48e3a55888a3": {
    summary:
      "The canonical Base WETH predeploy, read three ways. The same Deposit event backs both a " +
      "volume KPI and a count KPI, which is the clearest demonstration that the amount mode — not " +
      "the event — decides the unit.",
    kpis: [
      {action: "Wrap ETH into WETH, measured by size. One unit per 0.001 ETH.", kpiIndex: 0},
      {action: "The same wraps, counted. One unit per transaction, any size.", kpiIndex: 1},
      {action: "Unwrap WETH back into ETH. One unit per 0.001 ETH.", kpiIndex: 2},
    ],
  },
  // id 4 — "Uniswap". `_uniswap`: gated swap count off the pool, then USDC received at `WHOLE_USDC`.
  "0xabc517769c86a2122bce19422b7863296c8bcf90": {
    summary:
      "Swap WETH into USDC through the 0.3% pool. Progress is read off the USDC you receive rather " +
      "than the WETH you send: SwapRouter02 holds stranded ETH on Base Sepolia and wraps its own to " +
      "pay the pool, so the swapper's WETH never moves and a KPI on that leg would credit nothing.",
    kpis: [
      {action: "Swap through the 0.3% WETH/USDC pool. One unit per swap you receive.", kpiIndex: 0},
      {
        action: "The same swaps, by USDC received. One unit per whole USDC — six decimals, not 18.",
        kpiIndex: 1,
      },
    ],
  },
};

/** Ethereum Sepolia. The fixture is not seeded there, so there is nothing to describe. */
const SEPOLIA: GuidesByCampaign = {};

/**
 * Chain-scoped, for the reason `knownContracts.ts` gives: an address only means something together
 * with the chain it was deployed on, and a local anvil replaying these addresses holds different code.
 */
const CATALOG: Readonly<Record<number, GuidesByCampaign>> = {
  [baseSepolia.id]: BASE_SEPOLIA,
  [sepolia.id]: SEPOLIA,
};

/** The committed guide for a campaign, or `undefined` when there is none. */
export function catalogGuide(
  chainId: number | undefined,
  campaign: string | undefined,
): CampaignGuide | undefined {
  if (chainId === undefined || !campaign) return undefined;
  return CATALOG[chainId]?.[campaign.toLowerCase()];
}

// ── resolution ───────────────────────────────────────────────────

/**
 * Which guide a campaign page shows.
 *
 * A stored guide wins **wholesale**, not field by field. Merging would let a project's summary sit
 * above the catalog's KPI prose under one provenance note, and the note would then be false about
 * half of what it labels. One source per card keeps "these links came from the project" a statement
 * that is either true or absent.
 *
 * Sanitizes on the way out as well as on the way in. `stored` arrives from an HTTP response, and the
 * route that wrote it is not the only thing that could ever have — a hand-edited store file, or a
 * `BONEY_GUIDE_STORE` pointed somewhere unexpected, both reach here. Cheap, and it means the panel
 * never has to ask whether a URL was checked.
 */
export function resolveCampaignGuide(input: {
  chainId: number | undefined;
  campaign: string | undefined;
  /** The stored guide from `/api/campaign-guide`, when the fetch landed and found one. */
  stored?: CampaignGuide | null;
}): ResolvedGuide | null {
  const stored = input.stored ? sanitizeGuide(input.stored) : undefined;
  if (stored && !isEmptyGuide(stored)) return {...stored, provenance: "project"};

  const catalog = catalogGuide(input.chainId, input.campaign);
  if (catalog && !isEmptyGuide(catalog)) return {...catalog, provenance: "catalog"};

  return null;
}

/** Whether a guide would render as an empty card. Cheaper to detect here than in three components. */
export function isEmptyGuide(guide: CampaignGuide): boolean {
  const hasKpiCopy = (guide.kpis ?? []).some((k) => k.action?.trim() || k.url);
  return !guide.summary?.trim() && !guide.siteUrl && !hasKpiCopy;
}

/**
 * The guide entry for one KPI.
 *
 * Tolerates every shape a store can hold: no `kpis` array at all (a campaign-level-only guide), an
 * index the campaign does not have (a KPI count that changed — impossible today, since `KpiSpec` is
 * written in `Campaign`'s constructor and has no setter, but a stored file outlives assumptions), and
 * duplicates, where the first entry wins.
 */
export function guideForKpi(
  guide: CampaignGuide | null | undefined,
  kpiIndex: number,
): KpiGuide | undefined {
  return guide?.kpis?.find((k) => k.kpiIndex === kpiIndex);
}

// ── sanitizing ───────────────────────────────────────────────────

/**
 * A guide reduced to what we will store and render: trimmed, length-capped, URLs checked.
 *
 * Drops rather than rejects. A guide is advisory copy, so a bad URL costs the project one link and
 * keeps the sentence beside it — refusing the whole guide because one field was wrong would throw
 * away good prose over a typo. `validateGuideDraft` is what tells the project *which* field was
 * dropped; this is what makes the drop safe.
 */
export function sanitizeGuide(raw: unknown): CampaignGuide {
  const input = (raw ?? {}) as Record<string, unknown>;

  const summary = capped(input.summary, MAX_SUMMARY_LENGTH);
  const siteUrl = safeExternalUrl(input.siteUrl);

  const kpis = Array.isArray(input.kpis)
    ? input.kpis
        .map((entry) => sanitizeKpiGuide(entry))
        .filter((entry): entry is KpiGuide => entry !== undefined)
    : undefined;

  return {
    ...(summary ? {summary} : {}),
    ...(siteUrl ? {siteUrl} : {}),
    ...(kpis && kpis.length > 0 ? {kpis} : {}),
  };
}

function sanitizeKpiGuide(raw: unknown): KpiGuide | undefined {
  const input = (raw ?? {}) as Record<string, unknown>;

  const kpiIndex = Number(input.kpiIndex);
  if (!Number.isInteger(kpiIndex) || kpiIndex < 0) return undefined;

  const action = capped(input.action, MAX_ACTION_LENGTH);
  const url = safeExternalUrl(input.url);
  // An entry with neither is a row that says only what the chain already said, so it is not stored.
  if (!action && !url) return undefined;

  return {kpiIndex, ...(action ? {action} : {}), ...(url ? {url} : {})};
}

function capped(raw: unknown, limit: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

// ── the form's side ──────────────────────────────────────────────

/**
 * What a guide form holds while it is being typed — strings, like `CampaignDraft`.
 *
 * Deliberately *not* part of `CampaignDraft`. That type is the input to
 * `campaignArgs.buildCreateCampaignArgs`, and every field in it becomes a `createCampaign` argument;
 * a guide becomes none of them. Keeping them separate is what stops the encoder from having to know
 * about fields it must ignore.
 *
 * Two forms edit one of these — the create page and the project's editor on the campaign page — which
 * is why the shape and its two conversions live here rather than in either component.
 */
export type GuideDraft = {
  summary: string;
  siteUrl: string;
  /** One entry per KPI in the draft, index-aligned. */
  kpis: {action: string; url: string}[];
};

export function emptyGuideDraft(kpiCount: number): GuideDraft {
  return {
    summary: "",
    siteUrl: "",
    kpis: Array.from({length: kpiCount}, () => ({action: "", url: ""})),
  };
}

/**
 * An existing guide reopened for editing — the inverse of `guideFromDraft`.
 *
 * `kpiCount` comes from the campaign rather than from the guide, and it wins: a KPI the guide never
 * described still needs a blank row to type into, and a stored entry past the campaign's KPI count is
 * dropped rather than rendered as a row no KPI would ever read.
 *
 * A guide that came from `CATALOG` reopens the same way a stored one does, which is what lets a project
 * take over the committed copy by editing it. That is the intended direction — the project's own words
 * about its own campaign beat ours (see `resolveCampaignGuide`).
 */
export function guideDraftFrom(guide: CampaignGuide | null | undefined, kpiCount: number): GuideDraft {
  return {
    kpis: Array.from({length: kpiCount}, (_, kpiIndex) => {
      const entry = guideForKpi(guide, kpiIndex);
      return {action: entry?.action ?? "", url: entry?.url ?? ""};
    }),
    siteUrl: guide?.siteUrl ?? "",
    summary: guide?.summary ?? "",
  };
}

/** A draft as it will be stored. Index in the array *is* `kpiIndex`, which is what aligns them. */
export function guideFromDraft(draft: GuideDraft): CampaignGuide {
  return sanitizeGuide({
    kpis: draft.kpis.map((kpi, kpiIndex) => ({...kpi, kpiIndex})),
    siteUrl: draft.siteUrl,
    summary: draft.summary,
  });
}

/**
 * What is wrong with a guide draft, in `validateCampaignDraft`'s vocabulary so one `issueFor` helper
 * serves both.
 *
 * **Advisory, and the caller must keep it that way.** These issues never block `createCampaign`. A
 * malformed link is not worth refusing an escrowed campaign over, and the alternative — validating at
 * submit — would mean discovering a typo after the gas was spent. Same posture as
 * `useEventSourceProbe`'s findings, and the same reason: the form warns, the chain decides. What they
 * do block is the guide POST, where dropping a field silently is the failure worth avoiding.
 */
export function validateGuideDraft(draft: GuideDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (draft.summary.trim().length > MAX_SUMMARY_LENGTH) {
    issues.push({
      message: `Keep the summary to ${MAX_SUMMARY_LENGTH} characters — the rest is cut.`,
      path: "guide.summary",
    });
  }

  if (draft.siteUrl.trim() && !safeExternalUrl(draft.siteUrl)) {
    issues.push({message: HTTPS_ONLY, path: "guide.siteUrl"});
  }

  draft.kpis.forEach((kpi, i) => {
    if (kpi.action.trim().length > MAX_ACTION_LENGTH) {
      issues.push({
        message: `Keep this to ${MAX_ACTION_LENGTH} characters — the rest is cut.`,
        path: `guide.kpis.${i}.action`,
      });
    }
    if (kpi.url.trim() && !safeExternalUrl(kpi.url)) {
      issues.push({message: HTTPS_ONLY, path: `guide.kpis.${i}.url`});
    }
  });

  return issues;
}

const HTTPS_ONLY =
  "Use a full https:// address. Plain http and anything else is dropped rather than shown to a " +
  "referral.";

// ── authorization ────────────────────────────────────────────────

/**
 * The exact string a project signs to publish a guide.
 *
 * `/api/campaign-guide` reads `Campaign.project()` and checks this signature against it, which is
 * what keeps the store from being an open field for outbound links: without it, anyone could point
 * the Aave campaign's "do this here" at a drainer, on a page a referral has just been told to trust.
 *
 * Built here rather than in the route so the client and the server produce byte-identical text. Three
 * properties are load-bearing:
 *
 *  - **The chain id and campaign address are in the message.** A signature is otherwise replayable
 *    onto the same campaign address on another chain, or lifted onto a different campaign entirely.
 *  - **The guide is hashed by value, canonically.** `JSON.stringify` over a fixed key order, not the
 *    object's own — insertion order would make an equivalent guide sign differently, and the server
 *    rebuilds this from its own sanitized copy rather than trusting the client's bytes.
 *  - **The sanitized guide is what is signed.** The project signs what will be stored, not what they
 *    typed, so a dropped field cannot arrive as something they never agreed to.
 */
export function canonicalGuideMessage(input: {
  chainId: number;
  campaign: string;
  guide: CampaignGuide;
}): string {
  const guide = sanitizeGuide(input.guide);

  const body = JSON.stringify({
    kpis: (guide.kpis ?? [])
      .slice()
      .sort((a, b) => a.kpiIndex - b.kpiIndex)
      .map((k) => ({action: k.action ?? "", kpiIndex: k.kpiIndex, url: k.url ?? ""})),
    siteUrl: guide.siteUrl ?? "",
    summary: guide.summary ?? "",
  });

  return [
    "Boney campaign guide",
    `chain: ${input.chainId}`,
    `campaign: ${input.campaign.toLowerCase()}`,
    `guide: ${body}`,
  ].join("\n");
}
