import {formatDateTime, formatDuration, shortAddress} from "./format";
import {actionLabel, type LifecycleAction} from "./lifecycle";
import {addressRow, amountRow, type SignIntent, type SignKind} from "./signIntent";
import type {CampaignDraft} from "./validation";

/**
 * The confirmation copy for every wallet prompt the app opens.
 *
 * One builder per write, kept pure so the wording, the row list, and the prompt count are all
 * unit-testable. The hooks in `hooks/useWriteCampaign` and the two standalone signing hooks call
 * these and hand the result to `components/SignatureGate`.
 *
 * Facts a hook cannot know — a token's symbol, a campaign's name, a KPI's label — arrive through
 * each builder's `ctx` argument and are replaced by the address or index when absent.
 */

/** Human labels a call site can supply for facts the hooks hold only as addresses or indexes. */
export type IntentContext = {
  /** Reward token symbol, for amount rows. */
  symbol?: string;
  /** Reward token decimals, when the caller knows them and the hook does not. */
  decimals?: number;
  /** Campaign name, shown instead of its address or id. */
  campaignName?: string;
  /** KPI name, shown instead of its index. */
  kpiLabel?: string;
};

/** Names a campaign by its title when known, and by its address otherwise. */
function campaignValue(campaign: string, ctx?: IntentContext): string {
  return ctx?.campaignName ?? shortAddress(campaign);
}

/** Names a KPI by its label when known, and by its index otherwise. */
function kpiValue(kpiIndex: number, ctx?: IntentContext): string {
  return ctx?.kpiLabel ?? `#${kpiIndex}`;
}

/**
 * `Boney.createCampaign` — registering the campaign and its terms.
 *
 * @param draft The form's contents, in display units.
 * @param ctx Human labels for the reward token.
 * @returns The confirmation copy.
 */
export function createCampaignIntent(draft: CampaignDraft, ctx?: IntentContext): SignIntent {
  return {
    title: "Create campaign",
    summary:
      "Registers the campaign and its terms on chain. No tokens move yet — escrow arrives in a separate funding step.",
    rows: [
      {label: "Name", value: draft.name || "—"},
      {
        label: "Reward pool",
        value: ctx?.symbol ? `${draft.rewardPool} ${ctx.symbol}` : draft.rewardPool,
        hint: "The escrow you will fund. Every tier payout is drawn from it, and nothing can be paid beyond it.",
      },
      addressRow("Reward token", draft.token, "The ERC-20 promoters are paid in."),
      {label: "Opens", value: formatDateTime(draft.startTime)},
      {label: "Closes", value: formatDateTime(draft.endTime)},
      {
        label: "Attribution window",
        value: formatDuration(draft.attributionWindow),
        hint: "How long a referral stays credited to the promoter who introduced them. Activity after it expires counts for nobody.",
      },
      {
        label: "Minimum BoneyScore",
        value: draft.minReputation,
        hint: "Promoters below this score cannot join. The check runs on chain, against attestations they have submitted.",
      },
      {label: "KPIs", value: String(draft.kpis.length)},
    ],
    important:
      "These terms are fixed once the campaign exists. Changing any of them means creating a new campaign.",
    tone: "warning",
    confirmLabel: "Create campaign",
    prompts: ["transaction"],
  };
}

/**
 * `Boney.fundCampaign` — moving the reward pool into escrow.
 *
 * @param campaignId Registry id of the campaign.
 * @param amount Amount in base units.
 * @param token Reward token address.
 * @param decimals Reward token decimals.
 * @param ctx Human labels for the token and campaign.
 * @returns The confirmation copy.
 */
export function fundCampaignIntent(
  campaignId: bigint,
  amount: bigint,
  token: `0x${string}`,
  decimals: number,
  ctx?: IntentContext,
): SignIntent {
  return {
    title: "Fund escrow",
    summary:
      "Transfers the reward pool into the campaign's escrow, where the contract holds it until tiers are verified.",
    rows: [
      {label: "Campaign", value: ctx?.campaignName ?? `#${campaignId}`},
      amountRow("Amount", amount, decimals, ctx?.symbol, "Leaves your wallet in this transaction."),
      addressRow("Reward token", token),
      {
        label: "Token approval",
        value: "A second prompt, if needed",
        hint: "An ERC-20 must be approved before the escrow can pull it. Your allowance is checked first, and the approval is skipped when it already covers this amount.",
      },
    ],
    important:
      "Escrow is released to promoters as they cross tiers. What is left returns to you only after the campaign ends and its claim window closes.",
    tone: "warning",
    confirmLabel: "Fund escrow",
    prompts: ["transaction"],
  };
}

/** Per-action wording for the project-side lifecycle calls. */
const LIFECYCLE: Record<
  LifecycleAction,
  {summary: string; important: string; tone: SignIntent["tone"]}
> = {
  activate: {
    summary: "Opens the campaign so promoters can join and start earning against its KPIs.",
    important:
      "Escrow is committed from this point. Promoters who join can be paid out of it as soon as they cross a tier.",
    tone: "warning",
  },
  pause: {
    summary: "Stops progress from being credited while leaving the campaign in place.",
    important:
      "Promoters keep the attribution and the progress they already have. Nothing is forfeited by pausing.",
    tone: "info",
  },
  unpause: {
    summary: "Resumes crediting on a paused campaign.",
    important: "Activity that happened while paused is not backfilled.",
    tone: "info",
  },
  end: {
    summary: "Closes the campaign at this block. No further progress is credited after it.",
    important:
      "Ending is final. Promoters keep a claim window to collect what they already earned, and unspent escrow can be reclaimed once that window closes.",
    tone: "warning",
  },
  cancel: {
    summary: "Cancels the campaign and stops all further payouts.",
    important:
      "Cancelling is final and cannot be undone. Promoters who have not been paid for a crossed tier lose the chance to be.",
    tone: "critical",
  },
  reclaimUnspent: {
    summary: "Returns escrow that was never paid out to your wallet.",
    important:
      "Only what remains after every settled tier comes back. This is available once the claim window has closed.",
    tone: "info",
  },
};

/**
 * The no-argument lifecycle calls on a `Campaign`.
 *
 * @param action Which lifecycle call is about to be sent.
 * @param campaign The campaign's own address.
 * @param ctx Human labels for the campaign.
 * @returns The confirmation copy.
 */
export function lifecycleIntent(
  action: LifecycleAction,
  campaign: `0x${string}`,
  ctx?: IntentContext,
): SignIntent {
  const copy = LIFECYCLE[action];
  const label = actionLabel(action);

  return {
    title: label,
    summary: copy.summary,
    rows: [
      {label: "Campaign", value: campaignValue(campaign, ctx)},
      {label: "Action", value: `Campaign.${action}()`, mono: true},
    ],
    important: copy.important,
    tone: copy.tone,
    confirmLabel: label,
    prompts: ["transaction"],
  };
}

/**
 * `Campaign.join` — registering as a promoter.
 *
 * @param campaign The campaign's own address.
 * @param ctx Human labels for the campaign.
 * @returns The confirmation copy.
 */
export function joinCampaignIntent(campaign: `0x${string}`, ctx?: IntentContext): SignIntent {
  return {
    title: "Promote this campaign",
    summary:
      "Registers your wallet as a promoter on this campaign and assigns the referral id your links are built from.",
    rows: [
      {label: "Campaign", value: campaignValue(campaign, ctx)},
      addressRow("Promoting", campaign, "The campaign records the signing wallet as the promoter."),
    ],
    important:
      "Your BoneyScore is checked on chain: if it is below the campaign's minimum, the transaction reverts and you are charged only gas. Promoting is public and cannot be undone.",
    tone: "info",
    confirmLabel: "Promote campaign",
    prompts: ["transaction"],
  };
}

/**
 * `Campaign.settle` — paying out a tier that was crossed but never released.
 *
 * @param campaign The campaign's own address.
 * @param promoter The promoter being paid.
 * @param kpiIndex Which KPI's tier ladder to walk.
 * @param ctx Human labels for the campaign and KPI.
 * @returns The confirmation copy.
 */
export function settleIntent(
  campaign: `0x${string}`,
  promoter: `0x${string}`,
  kpiIndex: number,
  ctx?: IntentContext,
): SignIntent {
  return {
    title: "Release earned rewards",
    summary: "Pays out tiers this promoter has already crossed but has not been paid for.",
    rows: [
      {label: "Campaign", value: campaignValue(campaign, ctx)},
      {label: "KPI", value: kpiValue(kpiIndex, ctx)},
      addressRow("Paid to", promoter, "The campaign pays the promoter named here, not the wallet signing."),
    ],
    important:
      "Anyone can send this, and it pays only what the contract already owes. One KPI per transaction, so a promoter owed on two KPIs needs two.",
    tone: "info",
    confirmLabel: "Release rewards",
    prompts: ["transaction"],
  };
}

/**
 * `AttributionRegistry.storeTouch` — linking a referral to a promoter.
 *
 * @param campaign The campaign the touch is scoped to.
 * @param promoterId The promoter being credited.
 * @param ctx Human labels for the campaign.
 * @returns The confirmation copy.
 */
export function storeTouchIntent(
  campaign: `0x${string}`,
  promoterId: string,
  ctx?: IntentContext,
): SignIntent {
  return {
    title: "Confirm attribution",
    summary:
      "Links your wallet to this promoter's referral, so activity you go on to do in the campaign is credited to them.",
    rows: [
      {label: "Campaign", value: campaignValue(campaign, ctx)},
      {label: "Promoter", value: shortAddress(promoterId, 10, 6), mono: true},
    ],
    important:
      "The link holds for the campaign's attribution window and cannot be reassigned while it does.",
    tone: "info",
    confirmLabel: "Confirm attribution",
    prompts: ["signature", "transaction"],
  };
}

/** One planned `reportUserAction`, as the confirmation copy needs it. */
export type ReportedCall = {
  referral: `0x${string}`;
  /** The cumulative figure this call submits for the referral. */
  newTotal: bigint;
  /** KPI units this call adds to the promoter being reported for. */
  delta: bigint;
  /** KPI units in the same call that land on promoters who held the referral earlier. */
  elsewhere: bigint;
};

/** Referral rows listed in full before they collapse to a count. */
const REPORT_ROW_LIMIT = 5;

/**
 * `Campaign.reportUserAction` — crediting observed activity, one referral per transaction.
 *
 * States the promoter and the figures rather than the referral count alone: the credit lands on a
 * promoter's ladder, the referrals are only where the activity was measured, and a cumulative total
 * can carry units belonging to whoever held the referral before.
 *
 * @param campaign The campaign's own address.
 * @param kpiIndex Which KPI is being credited.
 * @param promoter The promoter the report credits.
 * @param calls The planned calls, in the order they will be sent.
 * @param ctx Human labels for the campaign and KPI.
 * @returns The confirmation copy.
 */
export function reportIntent(
  campaign: `0x${string}`,
  kpiIndex: number,
  promoter: `0x${string}`,
  calls: readonly ReportedCall[],
  ctx?: IntentContext,
): SignIntent {
  const gains = calls.reduce((sum, call) => sum + call.delta, BigInt(0));
  const elsewhere = calls.reduce((sum, call) => sum + call.elsewhere, BigInt(0));
  const kpi = kpiValue(kpiIndex, ctx);
  // "12 deposits" where the KPI has a name, "12 KPI units" where it is known only by index — an
  // unlabelled KPI would otherwise read as "12 #0".
  const unit = ctx?.kpiLabel ? ctx.kpiLabel.toLowerCase() : "KPI units";
  const listed = calls.slice(0, REPORT_ROW_LIMIT);

  return {
    title: "Report progress",
    summary:
      `Credits activity measured on chain to ${shortAddress(promoter)}, for the wallets it ` +
      "introduced. Progress moves on that promoter's ladder; the referrals are only where the " +
      "activity happened.",
    rows: [
      {label: "Campaign", value: campaignValue(campaign, ctx)},
      {label: "KPI", value: kpi},
      addressRow(
        "Credited to",
        promoter,
        "The promoter whose progress and tier payouts this moves. Nothing is credited to the referrals themselves.",
      ),
      {
        label: `${shortAddress(promoter)} gains`,
        value: `${gains.toString()} ${unit}`,
        hint: "Added to this promoter's progress on this KPI. Tier payouts are released from it in the same transactions.",
      },
      ...(elsewhere > BigInt(0)
        ? [
            {
              label: "Other promoters gain",
              value: `${elsewhere.toString()} ${unit}`,
              hint: "These referrals acted under an earlier promoter too. Each report submits the referral's whole total and the contract credits every action to whoever held that referral at the time, so this part goes to them.",
            },
          ]
        : []),
      ...listed.map((call) => ({
        label: shortAddress(call.referral),
        value: `+${call.delta.toString()}, total ${call.newTotal.toString()}`,
        mono: true,
        hint:
          call.elsewhere > BigInt(0)
            ? `Submits ${call.newTotal.toString()} for this referral: ${call.delta.toString()} credits ${shortAddress(promoter)} and ${call.elsewhere.toString()} credits the promoter who held it earlier.`
            : `Submits ${call.newTotal.toString()} for this referral, all of it credited to ${shortAddress(promoter)}.`,
      })),
      ...(calls.length > listed.length
        ? [
            {
              label: "And",
              value: `${calls.length - listed.length} more referrals`,
              hint: "One transaction each, in the same run.",
            },
          ]
        : []),
    ],
    important:
      "Each report settles inline: a tier crossed by a report pays out in the same transaction. They are sent one at a time and the run stops at the first failure, so a partial sequence has already moved money.",
    tone: "warning",
    confirmLabel: calls.length === 1 ? "Send report" : `Send ${calls.length} reports`,
    prompts: Array.from({length: Math.max(1, calls.length)}, (): SignKind => "transaction"),
  };
}

/**
 * `ReputationRegistry.submitAttestation` — publishing a signed score on chain.
 *
 * @param schemas Names of the schemas being submitted, in order.
 * @returns The confirmation copy.
 */
export function attestationIntent(schemas: readonly string[]): SignIntent {
  return {
    title: "Publish your reputation",
    summary:
      "Writes your signed Ethos score and reach on chain, where a campaign's reputation gate can read them.",
    rows: [
      {label: "Schemas", value: schemas.length ? schemas.join(", ") : "—"},
      {
        label: "Signed by",
        value: "Boneyard attestor",
        hint: "The score was signed off chain by the attestor key. Your wallet only submits it, which is why the signature is useless for any other wallet.",
      },
    ],
    important:
      "One transaction per schema, and they must land in order — the verifier consumes a nonce per signature. Approve each prompt as it appears.",
    tone: "info",
    confirmLabel: schemas.length === 1 ? "Submit attestation" : `Submit ${schemas.length} attestations`,
    prompts: Array.from({length: Math.max(1, schemas.length)}, (): SignKind => "transaction"),
  };
}

/**
 * The off-chain guide signature.
 *
 * @param campaign The campaign the guide belongs to.
 * @param clearing Whether the guide is being withdrawn rather than published.
 * @param ctx Human labels for the campaign.
 * @returns The confirmation copy.
 */
export function publishGuideIntent(
  campaign: `0x${string}`,
  clearing: boolean,
  ctx?: IntentContext,
): SignIntent {
  return {
    title: clearing ? "Withdraw campaign guide" : "Publish campaign guide",
    summary: clearing
      ? "Signs a withdrawal, so the store can verify the request came from the project wallet."
      : "Signs the guide text, so the store can verify it came from the project wallet.",
    rows: [
      {label: "Campaign", value: campaignValue(campaign, ctx)},
      {
        label: "Stored",
        value: "Off chain",
        hint: "The guide is prose for promoters, not campaign terms. Nothing about it is enforced by the contracts.",
      },
    ],
    important:
      "A signature only — no transaction and no gas. The guide can be replaced or withdrawn at any time.",
    tone: "info",
    confirmLabel: clearing ? "Sign withdrawal" : "Sign guide",
    prompts: ["signature"],
  };
}

/**
 * The dev stub allowlist signature.
 *
 * @param wallet The wallet being added or removed.
 * @param action Which change is being signed.
 * @returns The confirmation copy.
 */
export function stubAllowlistIntent(wallet: string, action: "add" | "remove"): SignIntent {
  return {
    title: action === "add" ? "Add to stub allowlist" : "Remove from stub allowlist",
    summary:
      action === "add"
        ? "Signs a request to score this wallet from the local stub instead of live Ethos."
        : "Signs a request to return this wallet to live Ethos scoring.",
    rows: [addressRow("Wallet", wallet), {label: "Change", value: action}],
    important:
      "A signature only — no gas. The route verifies it against the admin wallet, which is the real boundary; the button is only visible to that wallet.",
    tone: "info",
    confirmLabel: "Sign change",
    prompts: ["signature"],
  };
}
