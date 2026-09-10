"use client";

import {useState, useCallback, useId, type ReactNode} from "react";
import {useRouter} from "next/navigation";
import {useAccount} from "wagmi";
import {Card} from "@/components/ui/Card";
import {ErrorState} from "@/components/ui/States";
import {Notice} from "@/components/ui/Notice";
import {
  CheckboxField,
  Field,
  FieldLabel,
  FieldNote,
  SelectField,
  controlClass,
  describedBy,
} from "@/components/ui/Field";
import {useCreateCampaign, isPending} from "@/hooks/useWriteCampaign";
import {usePublishGuide} from "@/hooks/usePublishGuide";
import {useTokenMeta} from "@/hooks/useTokenMeta";
import {useNameAvailability} from "@/hooks/useNameAvailability";
import {useScoreCeiling} from "@/hooks/useScoreCeiling";
import {useNow} from "@/hooks/useNow";
import {useEventSourceProbe} from "@/hooks/useEventSourceProbe";
import {
  validateCampaignDraft,
  isBoundedScoreCeiling,
  parseCount,
  type CampaignDraft,
  type ValidationIssue,
  type KpiDraft,
  type TierDraft,
  type EventSourceDraft,
} from "@/lib/validation";
import {describeThreshold, describeUnit, type UnitInput} from "@/lib/kpiUnits";
import {
  MAX_ACTION_LENGTH,
  MAX_SUMMARY_LENGTH,
  emptyGuideDraft,
  guideFromDraft,
  isEmptyGuide,
  validateGuideDraft,
  type GuideDraft,
} from "@/lib/campaignGuide";
import {KPI_KIND, MAX_CAMPAIGN_NAME_LENGTH, type KpiKind} from "@/lib/types";
import {MAX_BONEY_SCORE} from "@/lib/boneyscore";
import {AMOUNT_MODE, EVENT_PRESETS} from "@/lib/kpiSource";
import {
  DURATION_UNITS,
  formatDateTime,
  formatDuration,
  fromDateTimeLocal,
  joinDuration,
  splitDuration,
  toDateTimeLocal,
  type DurationUnit,
} from "@/lib/format";

/*
  Layout.

  The form is a single column capped at `max-w-4xl`. Inside `main`'s `max-w-6xl` the old version let
  every input run the full 1,150px, which is unreadable for an address and absurd for a number. From
  `lg` up each section splits into a heading rail on the left and a fields column on the right, so a
  wide screen buys structure — the section's name and what it is for stay beside its fields as you
  scroll — rather than wider inputs. Below `lg` the rail stacks above the fields.

  Sections are separated by hairlines, not boxed. The page previously stacked seven `Card`s, one per
  section, with two more bordered boxes nested inside each KPI. A card marks a panel that stands on its
  own; a form's sections do not, and the borders were most of what the eye had to process. The one box
  left is the KPI block, because KPIs are repeatable and a repeated thing needs an edge.
*/

const SECTION_GRID = "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-x-12";

/*
  Button register.

  Solid brand is the page's one primary action (Create Campaign), matching the nav's own Create
  button. Actions that grow the campaign — add a KPI, add a tier — are brand outline: yellow enough
  to be found at a glance, which a muted dashed box was not, without a second solid block competing
  with the primary. Neutral outline is for stepping back (Reset, Try again). Removal stays quiet text
  that only turns critical on hover, so the destructive control is never the loudest thing in a block.
*/
const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-brand px-5 text-sm font-semibold text-plane transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-hairline-strong px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50";
const BRAND_OUTLINE_BUTTON =
  "w-full rounded-lg border border-brand bg-brand/5 px-4 py-3 text-sm font-semibold text-brand transition-colors hover:bg-brand/15";
const BRAND_OUTLINE_SMALL =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-brand bg-brand/5 px-2.5 text-xs font-semibold text-brand transition-colors hover:bg-brand/15";

export function CreateCampaignPage() {
  const {isConnected} = useAccount();
  const router = useRouter();
  const {state, create, reset, campaignId, campaignAddress} = useCreateCampaign();

  const [draft, setDraft] = useState<CampaignDraft>(() => defaultDraft());
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  /*
    The off-chain half — what a referral should do, and where.

    Held apart from `draft` on purpose. `CampaignDraft` is the input to `buildCreateCampaignArgs` and
    every field in it becomes a `createCampaign` argument; none of this does. Keeping them separate is
    what stops the encoder from having to know about fields it must ignore. The two arrays are kept
    index-aligned by the KPI mutators below, since a guide entry's position *is* its `kpiIndex`.
  */
  const [guide, setGuide] = useState<GuideDraft>(() => emptyGuideDraft(defaultDraft().kpis.length));
  const publishGuide = usePublishGuide();
  // Drives the "opens immediately" note. 0 until the clock is live — see `useNow`.
  const now = useNow();

  // Decimals come from the token contract, never from a form field — see useTokenMeta.
  const token = useTokenMeta(draft.token);
  const tokenDecimals = token.meta?.decimals;

  // Whether the registry already holds this name. Only a hint: the contract re-checks on submit and
  // is the one that decides.
  const nameCheck = useNameAvailability(draft.name);

  // The gate ceiling the constructor will actually compare `minReputation` against. Read rather than
  // assumed: an unseeded registry reports 0, which makes every gate unreachable — see the hook.
  const scoreCeiling = useScoreCeiling();

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // Without confirmed decimals every amount in the draft is unscalable. Refuse rather than
      // falling back to 18 and escrowing the wrong number.
      if (tokenDecimals === undefined) {
        setIssues([{path: "token", message: "Enter a readable ERC-20 address first."}]);
        return;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const found = validateCampaignDraft(draft, {
        tokenDecimals,
        nowSeconds,
        nameTaken: nameCheck.isTaken,
        scoreCeiling: scoreCeiling.ceiling,
      });
      setIssues(found);

      if (found.length > 0) return;

      await create(draft, tokenDecimals, {symbol: token.meta?.symbol, decimals: tokenDecimals});
    },
    [
      draft,
      tokenDecimals,
      token.meta?.symbol,
      create,
      nameCheck.isTaken,
      scoreCeiling.ceiling,
    ],
  );

  const updateField = <K extends keyof CampaignDraft>(key: K, value: CampaignDraft[K]) => {
    setDraft((prev) => ({...prev, [key]: value}));
  };

  const updateKpi = (index: number, updates: Partial<KpiDraft>) => {
    setDraft((prev) => ({
      ...prev,
      kpis: prev.kpis.map((k, i) => (i === index ? {...k, ...updates} : k)),
    }));
  };

  const updateTier = (kpiIndex: number, tierIndex: number, updates: Partial<TierDraft>) => {
    setDraft((prev) => ({
      ...prev,
      kpis: prev.kpis.map((k, i) =>
        i === kpiIndex
          ? {...k, tiers: k.tiers.map((t, j) => (j === tierIndex ? {...t, ...updates} : t))}
          : k,
      ),
    }));
  };

  /*
    KPI add and remove move the guide array too.

    A guide entry's position in the array *is* its `kpiIndex` (see `guideFromDraft`), so removing KPI 1
    without removing guide row 1 would silently reattach KPI 2's instructions to KPI 1 — an
    off-by-one that produces a page confidently telling a referral to do the wrong thing.
  */
  const addKpi = () => {
    setDraft((prev) => ({
      ...prev,
      kpis: [...prev.kpis, {kind: "Mint", verifier: "", target: "", aggregate: false, tiers: []}],
    }));
    setGuide((prev) => ({...prev, kpis: [...prev.kpis, {action: "", url: ""}]}));
  };

  const removeKpi = (index: number) => {
    setDraft((prev) => ({...prev, kpis: prev.kpis.filter((_, i) => i !== index)}));
    setGuide((prev) => ({...prev, kpis: prev.kpis.filter((_, i) => i !== index)}));
  };

  const updateGuideField = <K extends "summary" | "siteUrl">(key: K, value: string) => {
    setGuide((prev) => ({...prev, [key]: value}));
  };

  const updateGuideKpi = (index: number, updates: Partial<GuideDraft["kpis"][number]>) => {
    setGuide((prev) => ({
      ...prev,
      // Tolerates a guide array shorter than the draft's, which a hot reload during development can
      // produce. Missing rows are filled blank rather than throwing on an undefined spread.
      kpis: Array.from({length: Math.max(prev.kpis.length, index + 1)}, (_, i) => ({
        ...(prev.kpis[i] ?? {action: "", url: ""}),
        ...(i === index ? updates : {}),
      })),
    }));
  };

  const addTier = (kpiIndex: number) => {
    setDraft((prev) => ({
      ...prev,
      kpis: prev.kpis.map((k, i) =>
        i === kpiIndex ? {...k, tiers: [...k.tiers, {threshold: "", reward: ""}]} : k,
      ),
    }));
  };

  const removeTier = (kpiIndex: number, tierIndex: number) => {
    setDraft((prev) => ({
      ...prev,
      kpis: prev.kpis.map((k, i) =>
        i === kpiIndex ? {...k, tiers: k.tiers.filter((_, j) => j !== tierIndex)} : k,
      ),
    }));
  };

  const issueFor = (path: string): string | undefined => {
    return issues.find((i) => i.path === path)?.message;
  };

  /*
    Guide problems, computed every render rather than on submit.

    Advisory by design, and the wording says so: none of these blocks `createCampaign`. A malformed
    link is not worth refusing an escrowed campaign over, and validating at submit would mean finding
    the typo after the gas was spent. Same posture as `useEventSourceProbe`'s findings — the form warns
    while you type, and the only thing an unfixed issue costs is that field being dropped from the
    published guide.
  */
  const guideIssues = validateGuideDraft(guide);
  const guideIssueFor = (path: string): string | undefined => {
    return guideIssues.find((i) => i.path === path)?.message;
  };

  if (!isConnected) {
    return (
      <div className="max-w-4xl">
        <PageHeader />
        <Card>
          <ErrorState message="Connect a wallet to create a campaign." />
        </Card>
      </div>
    );
  }

  if (state.status === "confirmed" && campaignId !== undefined) {
    return (
      <div className="max-w-2xl">
        <CreatedCard
          campaignAddress={campaignAddress}
          campaignId={campaignId}
          campaignName={draft.name}
          guide={guide}
          onView={() => router.push(`/campaign/${campaignId.toString()}`)}
          publish={publishGuide}
        />
      </div>
    );
  }

  const symbol = token.meta?.symbol;
  const summaryLength = guide.summary.trim().length;

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl">
      <PageHeader />

      {state.status === "error" ? (
        <Notice
          tone="critical"
          title={state.message}
          detail={state.detail}
          className="mb-6"
          action={
            <button type="button" onClick={reset} className={SECONDARY_BUTTON}>
              Try again
            </button>
          }
        />
      ) : null}

      <div className="divide-y divide-hairline border-t border-hairline">
        <FormSection
          title="Campaign"
          description="The name is written on chain and never changes. The summary and link are published after creation and can be edited from the campaign page."
        >
          <Field
            label="Campaign name"
            value={draft.name}
            onChange={(v) => updateField("name", v)}
            error={issueFor("name")}
            maxLength={MAX_CAMPAIGN_NAME_LENGTH}
            placeholder="Summer swaps"
            hint={<NameStatus check={nameCheck} length={draft.name.length} />}
          />

          {/*
            The off-chain half of the campaign, and the only place a project can say what it wants done.

            None of this reaches the chain — `Types.CampaignConfig` has no slot for a sentence and
            `KpiSpec.params` is spent on the event source — so it is published separately, signed,
            after the campaign exists. See `lib/campaignGuide`.
          */}
          <Field
            label="What is this campaign about?"
            multiline
            rows={3}
            maxLength={MAX_SUMMARY_LENGTH}
            value={guide.summary}
            onChange={(v) => updateGuideField("summary", v)}
            error={guideIssueFor("guide.summary")}
            placeholder="What a promoter should tell people, in a sentence or two."
            hint={
              <>
                <span className="tnum">
                  {summaryLength}/{MAX_SUMMARY_LENGTH}
                </span>
                {" · Shown on the campaign page."}
              </>
            }
          />
          <Field
            label="Project link"
            inputMode="url"
            value={guide.siteUrl}
            onChange={(v) => updateGuideField("siteUrl", v)}
            error={guideIssueFor("guide.siteUrl")}
            placeholder="https://"
            hint="Optional. Where a referral is sent to take part."
          />
        </FormSection>

        <FormSection
          title="Reward pool"
          description="Rewards are paid in one ERC-20. Creating the campaign moves nothing — the pool is deposited into escrow in a separate step once the campaign exists."
        >
          <Field
            label="Token address"
            mono
            value={draft.token}
            onChange={(v) => updateField("token", v)}
            error={issueFor("token")}
            placeholder="0x…"
            hint={<TokenStatus token={token} />}
          />
          <Field
            label="Reward pool"
            inputMode="decimal"
            className="sm:max-w-xs"
            value={draft.rewardPool}
            onChange={(v) => updateField("rewardPool", v)}
            error={issueFor("rewardPool")}
            placeholder="25000"
            hint={
              tokenDecimals === undefined
                ? "Total to escrow, in whole tokens."
                : `Total to escrow, in whole ${symbol}.`
            }
          />
        </FormSection>

        <FormSection
          title="Window"
          description="Reports are credited only between the start and the end. The attribution window is how long a referral's signed visit keeps crediting the promoter who sent them."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <DateTimeField
              label="Starts"
              value={draft.startTime}
              onChange={(v) => updateField("startTime", v)}
              nowSeconds={now}
            />
            <DateTimeField
              label="Ends"
              value={draft.endTime}
              onChange={(v) => updateField("endTime", v)}
              error={issueFor("endTime")}
            />
          </div>
          <DurationField
            label="Attribution window"
            className="sm:max-w-xs"
            seconds={draft.attributionWindow}
            onChange={(v) => updateField("attributionWindow", v)}
            error={issueFor("attributionWindow")}
            hint="How long a visit stays creditable."
          />
        </FormSection>

        <FormSection
          title="Eligibility"
          description="Gate the campaign to promoters above a BoneyScore, or leave it open to everyone."
        >
          <Field
            label="Minimum BoneyScore"
            inputMode="numeric"
            className="sm:max-w-xs"
            value={draft.minReputation}
            onChange={(v) => updateField("minReputation", v)}
            error={issueFor("minReputation")}
            hint={
              <>
                0 opens it to every promoter. Scores run 0–{MAX_BONEY_SCORE.toLocaleString()}, and
                the gate cannot be changed once the campaign exists.
              </>
            }
          />
          <CeilingNote ceiling={scoreCeiling.ceiling} />
        </FormSection>

        <FormSection
          title="KPIs and reward tiers"
          description="Each KPI is one thing you want done and a ladder of rewards for doing it. Progress is credited from on-chain events, or from reports you submit yourself."
        >
          {issueFor("kpis") ? (
            <p role="alert" className="text-xs text-critical">
              {issueFor("kpis")}
            </p>
          ) : null}

          {draft.kpis.map((kpi, i) => (
            <KpiEditor
              key={i}
              index={i}
              kpi={kpi}
              guide={guide.kpis[i]}
              tokenSymbol={symbol}
              issueFor={issueFor}
              guideIssueFor={guideIssueFor}
              onChange={(updates) => updateKpi(i, updates)}
              onRemove={() => removeKpi(i)}
              onGuideChange={(updates) => updateGuideKpi(i, updates)}
              onTierChange={(j, updates) => updateTier(i, j, updates)}
              onAddTier={() => addTier(i)}
              onRemoveTier={(j) => removeTier(i, j)}
            />
          ))}

          {/* At the end of the list, where the next one would go, rather than a link in a header. */}
          <button type="button" onClick={addKpi} className={BRAND_OUTLINE_BUTTON}>
            + Add another KPI
          </button>
        </FormSection>
      </div>

      <div className={`border-t border-hairline pt-6 ${SECTION_GRID}`}>
        <div aria-hidden className="hidden lg:block" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <button
            type="submit"
            disabled={isPending(state) || tokenDecimals === undefined}
            className={PRIMARY_BUTTON}
          >
            {state.status === "preparing"
              ? "Awaiting signature…"
              : state.status === "submitted"
                ? "Mining…"
                : "Create Campaign"}
          </button>
          {state.status !== "idle" && state.status !== "error" ? (
            <button type="button" onClick={reset} className={SECONDARY_BUTTON}>
              Reset
            </button>
          ) : null}
          {/* Says why the button is off rather than leaving a disabled control to explain itself. */}
          <p className="text-xs text-ink-muted">
            {tokenDecimals === undefined
              ? "Enter a readable ERC-20 token address to enable creation."
              : "One transaction. Funding and activation follow from the campaign page."}
          </p>
        </div>
      </div>
    </form>
  );
}

function PageHeader() {
  return (
    <header className="pb-6">
      <h1 className="font-display text-2xl text-ink">Create a Campaign</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-secondary">
        Lock a reward pool in escrow, say what counts as progress, and promoters are paid as they
        cross each tier.
      </p>
    </header>
  );
}

/**
 * One section of the form: a heading rail and a column of fields.
 *
 * `section` + `aria-labelledby` rather than `fieldset` + `legend`: a legend is rendered outside the
 * fieldset's box model, which fights the two-column grid in every browser slightly differently, and
 * a labelled region gives a screen reader the same landmark to jump to.
 */
function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={`py-8 ${SECTION_GRID}`}>
      <div className="mb-5 lg:mb-0">
        <h2 id={headingId} className="text-sm font-bold text-brand">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{description}</p>
        ) : null}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

/**
 * Live name availability, as the field's own hint line.
 *
 * Under the input rather than in a separate paragraph, so a taken name is caught before a wallet
 * prompt rather than as a reverted transaction, and the counter sits where every other field's hint
 * does. The contract re-checks on submit and is what actually decides.
 */
function NameStatus({
  check,
  length,
}: {
  check: ReturnType<typeof useNameAvailability>;
  length: number;
}) {
  const counter = (
    <span className="tnum">
      {length}/{MAX_CAMPAIGN_NAME_LENGTH}
    </span>
  );

  return (
    <span role="status" aria-live="polite">
      {check.isIdle ? (
        counter
      ) : check.isLoading ? (
        <>{counter} · Checking availability…</>
      ) : check.isUnavailable ? (
        <>
          {counter} · Could not reach the registry to check this name. Creation is still rejected on
          chain if it is taken.
        </>
      ) : check.isTaken ? (
        <span className="text-critical">
          Taken. Names ignore case and extra spaces, so a variant of an existing name counts as the
          same one.
        </span>
      ) : (
        <>
          {counter} · <span className="text-good">Available</span>
        </>
      )}
    </span>
  );
}

/** The token as resolved from the chain — the decimals that scale every amount on the form. */
function TokenStatus({token}: {token: ReturnType<typeof useTokenMeta>}) {
  return (
    <span role="status" aria-live="polite">
      {token.isIdle ? (
        "The ERC-20 rewards are paid in. Its decimals are read from the contract."
      ) : token.isLoading ? (
        "Reading token…"
      ) : token.isUnreadable ? (
        <span className="text-critical">
          No ERC-20 metadata at this address on the connected network. Amounts cannot be scaled
          safely, so creation is blocked.
        </span>
      ) : (
        <span className="text-good">
          {token.meta?.symbol} · {token.meta?.decimals} decimals
        </span>
      )}
    </span>
  );
}

/**
 * One KPI: what it is, where its progress comes from, what a referral is told, and what it pays.
 *
 * The only bordered box on the form. Its four parts are separated by hairlines inside it rather
 * than nested in boxes of their own — the previous version put the event source and the referral
 * guide each in a second bordered surface, three borders deep by the time you reached a tier.
 */
function KpiEditor({
  index,
  kpi,
  guide,
  tokenSymbol,
  issueFor,
  guideIssueFor,
  onChange,
  onRemove,
  onGuideChange,
  onTierChange,
  onAddTier,
  onRemoveTier,
}: {
  index: number;
  kpi: KpiDraft;
  guide: GuideDraft["kpis"][number] | undefined;
  tokenSymbol?: string;
  issueFor: (path: string) => string | undefined;
  guideIssueFor: (path: string) => string | undefined;
  onChange: (updates: Partial<KpiDraft>) => void;
  onRemove: () => void;
  onGuideChange: (updates: Partial<GuideDraft["kpis"][number]>) => void;
  onTierChange: (tierIndex: number, updates: Partial<TierDraft>) => void;
  onAddTier: () => void;
  onRemoveTier: (tierIndex: number) => void;
}) {
  const n = index + 1;

  return (
    <div className="rounded-lg border border-hairline-strong bg-surface-1 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-bold text-brand">KPI {n}</h3>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove KPI ${n}`}
          className="text-xs text-ink-muted transition-colors hover:text-critical"
        >
          Remove
        </button>
      </div>

      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Kind"
            value={kpi.kind}
            onChange={(v) => onChange({kind: v as KpiKind})}
            options={KPI_KIND.map((k) => ({value: k, label: k}))}
            hint={kpi.kind === "Custom" ? "Custom needs a verifier adapter, below." : undefined}
          />
          <Field
            label="Target"
            inputMode="numeric"
            value={kpi.target}
            onChange={(v) => onChange({target: v})}
            error={issueFor(`kpis.${index}.target`)}
            hint="Optional. A campaign-wide goal, for display. Tiers decide payouts."
          />
        </div>
        <Field
          label="Verifier address"
          mono
          value={kpi.verifier}
          onChange={(v) => onChange({verifier: v})}
          error={issueFor(`kpis.${index}.verifier`)}
          placeholder="0x…"
          hint="Optional. An adapter that caps what a report may claim. Blank credits reports as-is."
        />
        <CheckboxField
          label="Aggregate only"
          checked={kpi.aggregate}
          onChange={(aggregate) => onChange({aggregate})}
          hint="Track progress for analytics. Pays no rewards."
        />
      </div>

      <Subsection title="Progress source">
        <EventSourceFields
          kpiIndex={index}
          kind={kpi.kind}
          value={kpi.eventSource}
          onChange={(eventSource) => onChange({eventSource})}
          issueFor={issueFor}
        />
      </Subsection>

      {/*
        What a referral does about this KPI, in words. Sits beside the event source because the two
        describe the same thing from opposite ends: that block says which log credits progress, this
        one says what a person has to do to emit it.
      */}
      <Subsection title="How a referral earns this">
        <Field
          label="Instruction"
          maxLength={MAX_ACTION_LENGTH}
          value={guide?.action ?? ""}
          onChange={(v) => onGuideChange({action: v})}
          error={guideIssueFor(`guide.kpis.${index}.action`)}
          placeholder="Swap at least 10 GYND on any pool"
          hint={`Optional. One line, up to ${MAX_ACTION_LENGTH} characters.`}
        />
        <Field
          label="Action link"
          inputMode="url"
          value={guide?.url ?? ""}
          onChange={(v) => onGuideChange({url: v})}
          error={guideIssueFor(`guide.kpis.${index}.url`)}
          placeholder="https://"
          hint="Optional. Left blank, the campaign page links the watched contract on the block explorer instead."
        />
      </Subsection>

      <Subsection
        title="Reward tiers"
        action={
          <button type="button" onClick={onAddTier} className={BRAND_OUTLINE_SMALL}>
            + Add tier
          </button>
        }
      >
        {issueFor(`kpis.${index}.tiers`) ? (
          <p role="alert" className="text-xs text-critical">
            {issueFor(`kpis.${index}.tiers`)}
          </p>
        ) : null}
        <TierLadder
          kpi={kpi}
          kpiIndex={index}
          tokenSymbol={tokenSymbol}
          issueFor={issueFor}
          onTierChange={onTierChange}
          onRemoveTier={onRemoveTier}
        />
      </Subsection>
    </div>
  );
}

/** A titled part of a KPI block, divided from the previous one by a hairline. */
function Subsection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-5 border-t border-hairline pt-5">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{title}</h4>
        {action}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

const TIER_GRID = "grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2";

/**
 * The tiers as a ladder: one row per tier, threshold beside reward, column headings once.
 *
 * The previous markup declared `grid-cols-[1fr,1fr,auto]`, which is not a grid template — commas are
 * not separators in `grid-template-columns` — so the declaration was dropped and every tier rendered
 * as three stacked full-width controls with a lone × under them. Labels are kept for assistive tech
 * but hidden, since the column heading carries the text and repeating "Tier 3 threshold" on every row
 * was the other half of the clutter.
 */
function TierLadder({
  kpi,
  kpiIndex,
  tokenSymbol,
  issueFor,
  onTierChange,
  onRemoveTier,
}: {
  kpi: KpiDraft;
  kpiIndex: number;
  tokenSymbol?: string;
  issueFor: (path: string) => string | undefined;
  onTierChange: (tierIndex: number, updates: Partial<TierDraft>) => void;
  onRemoveTier: (tierIndex: number) => void;
}) {
  if (kpi.tiers.length === 0) {
    return (
      <p className="text-xs text-ink-muted">
        No tiers yet. A KPI with no tiers pays nothing — add one for each threshold that should
        trigger a payout.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div aria-hidden className={`${TIER_GRID} text-[11px] font-medium text-ink-muted`}>
        <span />
        <span>Threshold</span>
        <span>Reward{tokenSymbol ? ` (${tokenSymbol})` : ""}</span>
        <span />
      </div>
      {kpi.tiers.map((tier, j) => (
        <div key={j} className={`${TIER_GRID} items-start`}>
          <span className="tnum pt-2 text-xs font-semibold text-brand">{j + 1}</span>
          <div>
            <Field
              labelHidden
              label={`Tier ${j + 1} threshold`}
              inputMode="numeric"
              value={tier.threshold}
              onChange={(v) => onTierChange(j, {threshold: v})}
              error={issueFor(`kpis.${kpiIndex}.tiers.${j}.threshold`)}
            />
            {/*
              The threshold restated as the work it takes, right under the number being typed — the
              highest-leverage place to catch a scale mistake, since it is the exact spot the lynx
              project entered 50 meaning 50 wraps and got 500. Shown only for a count KPI with a
              scale above 1; `describeThreshold` returns null otherwise rather than echoing the
              figure above it.
            */}
            <TierActionHint kpi={kpi} threshold={tier.threshold} />
          </div>
          <Field
            labelHidden
            label={`Tier ${j + 1} reward`}
            inputMode="decimal"
            value={tier.reward}
            onChange={(v) => onTierChange(j, {reward: v})}
            error={issueFor(`kpis.${kpiIndex}.tiers.${j}.reward`)}
          />
          <button
            type="button"
            onClick={() => onRemoveTier(j)}
            aria-label={`Remove tier ${j + 1}`}
            className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-critical"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The post-creation screen, which is also where the guide gets published.
 *
 * Publishing is deliberately a *second, optional* step rather than part of creation. The campaign is
 * already on chain by the time this renders — refusing the signature, or the store being unwritable,
 * changes nothing about that. Folding the guide into `createCampaign` would have made a declined
 * signature look like a failed launch, and there is nowhere on chain to put the guide anyway.
 *
 * The signature is what the store authenticates against, so it cannot be skipped for convenience: these
 * are outbound links that will be shown to referrals on a page that has just told them they are
 * attributed to a promoter. See `/api/campaign-guide`.
 */
function CreatedCard({
  campaignAddress,
  campaignId,
  campaignName,
  guide,
  onView,
  publish,
}: {
  /** From the `CampaignCreated` log. Absent only if the log could not be decoded. */
  campaignAddress?: `0x${string}`;
  campaignId: bigint;
  /** The name just written on chain, as typed into the form. */
  campaignName: string;
  guide: GuideDraft;
  onView: () => void;
  publish: ReturnType<typeof usePublishGuide>;
}) {
  const built = guideFromDraft(guide);
  const nothingToPublish = isEmptyGuide(built);
  const {state} = publish;
  const busy = state.status === "signing" || state.status === "saving";
  const published = state.status === "saved" || state.status === "cleared";
  /*
    Campaign info was typed into the form and is not on the store yet. Nothing carries it across the
    navigation `onView` performs, so leaving now discards it — which is why publishing is the primary
    action while this holds.
  */
  const unpublished = !nothingToPublish && campaignAddress !== undefined && !published;

  return (
    <Card>
      <div className="space-y-4">
        <div className="space-y-1 text-center">
          <p className="text-sm text-good">Campaign created successfully!</p>
          {/* The name is what the project will look for in the list; the registry index is the
              fallback for a draft that somehow reached this screen without one. */}
          <p className="text-xs text-ink-muted">
            {campaignName.trim() || `Campaign #${campaignId.toString()}`}
          </p>
        </div>

        {/*
          Only shown when there is something to publish. A project that filled nothing in should not be
          handed a signature prompt to decline.
        */}
        {!nothingToPublish ? (
          <div className="rounded border border-hairline bg-surface-2 p-3">
            <p className="text-xs text-ink-secondary">
              Publish the campaign info so referrals see it. One signature from this wallet, no gas.
            </p>

            {campaignAddress === undefined ? (
              // The address comes out of the `CampaignCreated` log; without it there is nothing to key
              // the guide by, and guessing would write it against the wrong campaign.
              <p className="mt-2 text-xs text-brand">
                The campaign&rsquo;s address could not be read from the transaction receipt, so the
                info cannot be published from here.
              </p>
            ) : (
              <>
                <button
                  className={`mt-2 rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    unpublished
                      ? "bg-brand text-plane hover:opacity-90"
                      : "border border-hairline text-ink hover:bg-surface-hover"
                  }`}
                  disabled={busy || published}
                  onClick={() =>
                    void publish.publish(campaignAddress, built, {campaignName})
                  }
                  type="button"
                >
                  {state.status === "signing"
                    ? "Awaiting signature…"
                    : state.status === "saving"
                      ? "Publishing…"
                      : state.status === "saved" || state.status === "cleared"
                        ? "Published"
                        : "Publish campaign info"}
                </button>

                <PublishNote state={state} onRetry={publish.reset} />
              </>
            )}
          </div>
        ) : null}

        <div className="space-y-2 text-center">
          <button
            className={`rounded-md px-4 py-2 text-sm font-semibold ${
              unpublished
                ? "border border-hairline-strong text-ink hover:bg-surface-hover"
                : "bg-brand text-plane hover:opacity-90"
            }`}
            onClick={onView}
            type="button"
          >
            View Campaign
          </button>
          {unpublished ? (
            <p className="text-xs text-brand">
              The summary and links you typed are not saved yet. Leaving this screen discards them —
              you can still add them from the campaign page afterwards.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** The outcome of a publish attempt, including the one outcome the project has to act on. */
function PublishNote({
  state,
  onRetry,
}: {
  state: ReturnType<typeof usePublishGuide>["state"];
  onRetry: () => void;
}) {
  if (state.status === "saved") {
    return (
      <Notice tone="good" role="status" title="Published." className="mt-2">
        The campaign page shows it now.
      </Notice>
    );
  }

  if (state.status === "cleared") {
    return <p className="mt-2 text-xs text-ink-muted">Nothing to publish — every field was empty.</p>;
  }

  if (state.status === "error") {
    return (
      <Notice tone="critical" title="Not published" className="mt-2">
        {state.message}{" "}
        <button className="underline hover:text-ink" onClick={onRetry} type="button">
          Try again
        </button>
        . The campaign itself is unaffected.
      </Notice>
    );
  }

  if (state.status === "unwritable") {
    return (
      <div className="mt-2 space-y-1.5">
        <Notice tone="warning" title={state.message} />
        {/*
          The entry itself, not a link to documentation. The alternative is telling a project their
          guide is gone and leaving them to retype prose they have already written once.
        */}
        <pre className="max-h-40 overflow-auto rounded border border-hairline bg-surface-1 p-2 text-[10px] leading-relaxed text-ink-secondary">
          {JSON.stringify(state.entry, null, 2)}
        </pre>
      </div>
    );
  }

  return null;
}

/**
 * What this network's registry says the gate ceiling actually is.
 *
 * The line above quotes `MAX_BONEY_SCORE`, which is the arithmetic for the *seeded* schema
 * configuration. `Campaign`'s constructor compares against `ReputationRegistry.maxScore()` instead,
 * and the two part company on a registry that was deployed but never seeded: no weighted schemas means
 * a ceiling of 0, every wallet scoring 0, and `UnreachableReputation` on any gate at all. That is not
 * hypothetical — it is what a redeploy without `SeedDevRep` leaves behind, and it read as a form
 * cheerfully promising a 0–28,000 range while the chain accepted nothing.
 *
 * Renders nothing when the chain agrees with the constant, so the ordinary case stays quiet.
 */
function CeilingNote({ceiling}: {ceiling?: bigint}) {
  // Loading, or the registry could not be read. The line above already states the fallback range, and
  // the constructor remains the decider either way.
  if (ceiling === undefined) return null;

  if (ceiling === BigInt(0)) {
    return (
      <Notice tone="warning" title="No wallet can hold a BoneyScore on this network yet.">
        The reputation registry has no weighted schemas, so a gate above 0 would lock out everyone,
        permanently. Leave this at 0 until the schemas are registered.
      </Notice>
    );
  }

  if (!isBoundedScoreCeiling(ceiling)) {
    return (
      <p className="text-xs text-ink-muted">
        This network reports no score ceiling — a weighted schema has no value cap — so any gate is
        accepted.
      </p>
    );
  }

  if (ceiling === BigInt(MAX_BONEY_SCORE)) return null;

  return (
    <Notice
      tone="warning"
      title={`This network caps scores at ${ceiling.toLocaleString("en-US")}, not ${MAX_BONEY_SCORE.toLocaleString()}.`}
    >
      Its schema weights differ from the seeded ones. A gate above that is rejected on creation.
    </Notice>
  );
}

/**
 * Optional per-KPI event source — which contract and event feed this KPI's progress.
 *
 * Collapsed until enabled, because most KPIs do not have one: the field is new, every existing
 * campaign leaves it empty, and a project reporting by hand never needs it. Showing five inputs by
 * default would imply they are required.
 *
 * Encoded into `KpiSpec.params` at submit time — see `lib/kpiSource.ts` for the wire format.
 */
function EventSourceFields({
  kpiIndex,
  kind,
  value,
  onChange,
  issueFor,
}: {
  kpiIndex: number;
  /** This KPI's category, for the fallback noun when no signature has been typed. */
  kind: KpiKind;
  value: EventSourceDraft | undefined;
  onChange: (next: EventSourceDraft | undefined) => void;
  issueFor: (path: string) => string | undefined;
}) {
  const enabled = value !== undefined;
  const path = `kpis.${kpiIndex}.eventSource`;

  const set = (updates: Partial<EventSourceDraft>) => {
    onChange({...(value ?? emptyEventSource()), ...updates});
  };

  // Asks the chain whether this contract exists and emits this event. Advisory only — a project can
  // still submit while it is loading or reporting an error, because the probe reads the *connected*
  // chain and a campaign may legitimately target a contract deployed moments later.
  const probe = useEventSourceProbe({
    source: value?.source ?? "",
    signature: value?.signature ?? "",
    // The mode and scale drive the count-mode scale warning, which needs no chain read and no
    // address — see `classifyEventSource`.
    amountMode: value?.amountMode === "count" ? AMOUNT_MODE.count : AMOUNT_MODE.dataWord0,
    scale: value?.scale ?? "",
    // The chosen actor topic, so "topic N is empty" and "topic N is not an address" can be said
    // about the topic actually picked rather than about the event's shape alone.
    actorTopic: Number(value?.actorTopic ?? "1"),
    filterTopic: Number(value?.filterTopic ?? "0"),
    filterValue: value?.filterValue ?? "",
  });

  /** Fills every field from a verified preset, so a project need not assemble a topic by hand. */
  const applyPreset = (id: string) => {
    const preset = EVENT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    set({
      // The ERC-721 preset carries a zero address on purpose — the signature and topic layout are
      // the reusable part; which collection is being watched is always project-specific.
      source:
        preset.source.source === "0x0000000000000000000000000000000000000000"
          ? (value?.source ?? "")
          : preset.source.source,
      signature: preset.signature,
      actorTopic: String(preset.source.actorTopic),
      amountMode: preset.source.amountMode === AMOUNT_MODE.count ? "count" : "dataWord0",
      scale: preset.source.scale.toString(),
      // `in` rather than `??`: each preset keeps its own literal type, and the two without a filter
      // have no `filterTopic` member at all, which `??` cannot narrow past.
      filterTopic: String("filterTopic" in preset.source ? preset.source.filterTopic : 0),
      // Left for the project the way a zero source address is: a router preset names the shape, not
      // which router.
      filterValue: preset.filterValueIsPlaceholder
        ? (value?.filterValue ?? "")
        : "filterValue" in preset.source
          ? preset.source.filterValue
          : "",
    });
  };

  return (
    <>
      <CheckboxField
        label="Credit progress from on-chain events"
        checked={enabled}
        onChange={(on) => onChange(on ? emptyEventSource() : undefined)}
        hint="Off, you report this KPI yourself. On, name a contract and an event, and an indexer credits progress from its logs."
      />

      {enabled ? (
        <div className="space-y-4">
          <SelectField
            label="Preset"
            defaultValue=""
            onChange={applyPreset}
            options={[
              {value: "", label: "Custom…"},
              ...EVENT_PRESETS.map((p) => ({value: p.id, label: p.label})),
            ]}
            hint="Fills every field below from a shape that is known to decode."
          />

          <Field
            label="Source contract"
            mono
            value={value.source}
            onChange={(v) => set({source: v})}
            error={issueFor(`${path}.source`)}
            placeholder="0x…"
            hint="The contract whose logs credit this KPI. Only its own events count."
          />
          <Field
            label="Event signature"
            mono
            value={value.signature}
            onChange={(v) => set({signature: v})}
            error={issueFor(`${path}.signature`)}
            placeholder="Transfer(address,address,uint256)"
            hint="Types only, no names or spaces — the topic is the keccak of this exact string."
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Actor topic"
              value={value.actorTopic}
              onChange={(v) => set({actorTopic: v})}
              options={TOPIC_OPTIONS}
              error={issueFor(`${path}.actorTopic`)}
              hint="Which indexed topic holds the referral’s address. 1 is the event’s first indexed argument."
            />
            <SelectField
              label="Filter topic"
              value={value.filterTopic ?? "0"}
              onChange={(v) => set({filterTopic: v})}
              options={[{value: "0", label: "— none"}, ...TOPIC_OPTIONS]}
              error={issueFor(`${path}.filterTopic`)}
              hint="Optional. Narrows this KPI to logs carrying a fixed value at another topic."
            />
            <Field
              label="Filter value"
              mono
              value={value.filterValue ?? ""}
              onChange={(v) => set({filterValue: v})}
              error={issueFor(`${path}.filterValue`)}
              hint="What that topic must equal — the router a swap came through, or zeros for mints only."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Amount"
              value={value.amountMode}
              onChange={(v) => set({amountMode: v})}
              options={[
                {value: "count", label: "Count — 1 per event"},
                {value: "dataWord0", label: "Value — the event’s number"},
              ]}
              hint="Count adds 1 per event. Value reads the event’s first number."
            />
            <Field
              label="Scale"
              inputMode="numeric"
              value={value.scale}
              onChange={(v) => set({scale: v})}
              error={issueFor(`${path}.scale`)}
              hint="Divides that amount before crediting, so tier thresholds stay small numbers."
            />
          </div>

          {/*
            What the two fields above actually add up to, restated every keystroke. Their own hints
            state the mechanism; this states the resulting unit.

            The hint this replaced explained only the `dataWord0` case — "1e15 makes 0.001 of an
            18-decimal token one unit" — and said nothing about `count`, where a scale cannot measure
            size and only makes thresholds harder to reach. That omission is how the live lynx
            campaign came to credit 51 deposits as 5. Pure, so it needs no chain read and no debounce;
            base units rather than a token amount, because naming the token would mean reading its
            decimals and this updates faster than a request could land. See `lib/kpiUnits`.
          */}
          <p className="text-xs text-ink-secondary">= {describeUnit(unitFromDraft(kind, value))}</p>

          {/*
            Probe findings in the app's own `Notice` tones. These used to be Tailwind's light-theme
            palette (`bg-green-50`, `bg-red-50`) — pastel boxes on a near-black page — and the only
            place in the app that painted them. `data-probe-severity` stays on the wrapper because the
            event-probe driver script selects on it.
          */}
          {probe.findings.length > 0 && (
            <div className="space-y-2">
              {probe.findings.map((f, j) => (
                <div key={j} data-probe-severity={f.severity}>
                  <Notice
                    role="status"
                    tone={f.severity === "error" ? "critical" : f.severity === "warn" ? "warning" : "good"}
                    title={
                      <>
                        {f.severity === "error" ? (
                          <span className="font-semibold">Unusable: </span>
                        ) : f.severity === "warn" ? (
                          <span className="font-semibold">Unverified: </span>
                        ) : null}
                        {f.message}
                      </>
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {probe.isLoading && (
            <p className="animate-pulse text-xs text-ink-muted">
              Checking the chain for this contract and event…
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

/** `topics[0]` is the signature, so the selectable topic positions are 1..3. */
const TOPIC_OPTIONS = [
  {value: "1", label: "1"},
  {value: "2", label: "2"},
  {value: "3", label: "3"},
] as const;

function emptyEventSource(): EventSourceDraft {
  return {
    source: "",
    signature: "",
    actorTopic: "1",
    amountMode: "dataWord0",
    scale: "1",
    filterTopic: "0",
    filterValue: "",
  };
}

/**
 * A scale string as the encoder will read it, for the live unit preview.
 *
 * `parseCount` is the same parser `campaignArgs.buildKpiSpec` uses at submit, so the sentence
 * describes what would actually be encoded rather than a looser reading of the field: `1e15` is not a
 * whole number to either, and a blank means 1 to both (`effectiveScale`). Anything it rejects falls
 * back to 1 here, which keeps the preview honest — the number the KPI would carry if submitted now,
 * with the form's own "Enter a whole number." handling the malformed case separately.
 */
function parseScale(raw: string): bigint {
  return parseCount(raw.trim()) ?? BigInt(1);
}

/**
 * What one unit of progress would cost, as the draft currently stands.
 *
 * Shared by the sentence under the Scale field and the action count under each tier threshold, so the
 * two cannot disagree about what a unit is — which would be worse than either being absent.
 *
 * A KPI with no event source still gets an input, describing the `dataWord0` default. That is what
 * `emptyEventSource` sets, so it is what the KPI would carry if the box were ticked and nothing else
 * touched; `describeThreshold` returns null for it anyway, so no tier line appears.
 */
function unitFromDraft(kind: KpiKind, source: EventSourceDraft | undefined): UnitInput {
  return {
    amountMode: source?.amountMode === "count" ? AMOUNT_MODE.count : AMOUNT_MODE.dataWord0,
    kind,
    scale: parseScale(source?.scale ?? ""),
    signature: source?.signature,
  };
}

/**
 * A tier threshold restated as the number of actions behind it, or nothing.
 *
 * Renders under the threshold input while it is being typed. Silent for a hand-reported KPI (no event
 * source), for a threshold that is not a whole number yet, and for any KPI where the action count
 * equals the threshold — `describeThreshold` decides the last of these, and reads the same
 * `unitFromDraft` the sentence above the ladder does, so the two never contradict.
 */
function TierActionHint({kpi, threshold}: {kpi: KpiDraft; threshold: string}) {
  if (!kpi.eventSource) return null;

  const parsed = parseCount(threshold.trim());
  if (parsed === null) return null;

  const actions = describeThreshold(parsed, unitFromDraft(kpi.kind, kpi.eventSource));
  if (!actions) return null;

  return <p className="mt-1 text-[11px] text-ink-muted">= {actions}</p>;
}

/**
 * A unix timestamp edited as a date and time.
 *
 * The draft still carries seconds — only the input representation changes, so validation and
 * `campaignArgs` never see a formatted string. The hint restates the value as an absolute local
 * date because the picker's own rendering is browser- and locale-dependent, and a project escrowing
 * real tokens should be able to read back exactly which instant it chose.
 */
function DateTimeField({
  label,
  value,
  onChange,
  error,
  /**
   * Chain time to compare against, for the "opens immediately / not until" note.
   * `useNow` reports 0 until the clock is live, so 0 means "not ready" and suppresses the note
   * entirely. Treating it as a real timestamp would date every start to 1970 and mislabel an
   * already-open window as pending.
   */
  nowSeconds,
}: {
  label: string;
  value: number;
  onChange: (unixSeconds: number) => void;
  error?: string;
  nowSeconds?: number;
}) {
  const id = useId();

  // A future start is legal but costs real testing time: the campaign funds, activates, reads as
  // Active, and still rejects every report with `OutsideWindow` until it opens.
  const clockReady = nowSeconds !== undefined && nowSeconds > 0;
  const pending = clockReady && value > (nowSeconds as number);
  const delay = pending ? formatDuration(value - (nowSeconds as number)) : null;

  const hint = (
    <>
      {formatDateTime(value)} local
      {!clockReady ? null : pending ? (
        <>
          {" · "}
          <span className="text-brand">no reports credited for {delay}</span>
        </>
      ) : (
        " · opens immediately"
      )}
    </>
  );

  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type="datetime-local"
        value={toDateTimeLocal(value)}
        onChange={(e) => onChange(fromDateTimeLocal(e.target.value))}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={controlClass(!!error)}
      />
      <FieldNote id={id} error={error} hint={hint} />
    </div>
  );
}

/**
 * A duration in seconds edited as a number plus a unit.
 *
 * Unit state is derived from the incoming seconds rather than held separately, so the field cannot
 * drift out of step with the draft. The consequence worth knowing: typing 24 with `hours` selected
 * stores 86400, which splits back to `1 day` — the number visibly re-normalises under the cursor.
 * That is the honest trade for having no second source of truth, and it only bites on values that
 * are exactly equivalent anyway.
 */
function DurationField({
  label,
  seconds,
  onChange,
  error,
  hint,
  className = "",
}: {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
  error?: string;
  hint?: string;
  className?: string;
}) {
  const id = useId();
  const unitId = useId();
  const {value, unit} = splitDuration(seconds);

  return (
    <div className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <input
          id={id}
          type="number"
          min="0"
          inputMode="numeric"
          value={String(value)}
          onChange={(e) => onChange(joinDuration(Number(e.target.value), unit))}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          className={controlClass(!!error)}
        />
        {/* Its own accessible name — a shared label would leave the select reading as the number. */}
        <label htmlFor={unitId} className="sr-only">
          {label} unit
        </label>
        <select
          id={unitId}
          value={unit}
          onChange={(e) => onChange(joinDuration(value, e.target.value as DurationUnit))}
          className="shrink-0 rounded-md border border-hairline bg-surface-2 px-2 py-2 text-base text-ink hover:border-hairline-strong sm:text-sm"
        >
          {DURATION_UNITS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      <FieldNote id={id} error={error} hint={hint} />
    </div>
  );
}

function defaultDraft(): CampaignDraft {
  const now = Math.floor(Date.now() / 1000);
  return {
    name: "",

    token: "",
    rewardPool: "",
    startTime: now,
    endTime: now + 86400 * 30,
    // [bscoretest] Shortened from 7 days so a touch visibly expires within a testing session.
    // Restore to 86400 * 7 before any release/merge to main.
    attributionWindow: 30 * 60,
    minReputation: "0",
    kpis: [
      {
        kind: "Mint",
        verifier: "",
        target: "1000",
        aggregate: false,
        tiers: [
          {threshold: "10", reward: ""},
          {threshold: "50", reward: ""},
          {threshold: "100", reward: ""},
        ],
      },
    ],
  };
}
