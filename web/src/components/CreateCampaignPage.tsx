"use client";

import {useState, useCallback, useId} from "react";
import {useRouter} from "next/navigation";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {ErrorState} from "@/components/ui/States";
import {useCreateCampaign, isPending} from "@/hooks/useWriteCampaign";
import {useTokenMeta} from "@/hooks/useTokenMeta";
import {useNameAvailability} from "@/hooks/useNameAvailability";
import {useNow} from "@/hooks/useNow";
import {useEventSourceProbe} from "@/hooks/useEventSourceProbe";
import {validateCampaignDraft, type CampaignDraft, type ValidationIssue, type KpiDraft, type TierDraft, type EventSourceDraft} from "@/lib/validation";
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

export function CreateCampaignPage() {
  const {isConnected} = useAccount();
  const router = useRouter();
  const {state, create, reset, campaignId} = useCreateCampaign();

  const [draft, setDraft] = useState<CampaignDraft>(() => defaultDraft());
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  // Drives the "opens immediately" note. 0 until the clock is live — see `useNow`.
  const now = useNow();

  // Decimals come from the token contract, never from a form field — see useTokenMeta.
  const token = useTokenMeta(draft.token);
  const tokenDecimals = token.meta?.decimals;

  // Whether the registry already holds this name. Only a hint: the contract re-checks on submit and
  // is the one that decides.
  const nameCheck = useNameAvailability(draft.name);

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
      });
      setIssues(found);

      if (found.length > 0) return;

      await create(draft, tokenDecimals);
    },
    [draft, tokenDecimals, create, nameCheck.isTaken],
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

  const addKpi = () => {
    setDraft((prev) => ({
      ...prev,
      kpis: [...prev.kpis, {kind: "Mint", verifier: "", target: "", aggregate: false, tiers: []}],
    }));
  };

  const removeKpi = (index: number) => {
    setDraft((prev) => ({...prev, kpis: prev.kpis.filter((_, i) => i !== index)}));
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

  if (!isConnected) {
    return (
      <Card>
        <ErrorState message="Connect a wallet to create a campaign." />
      </Card>
    );
  }

  if (state.status === "confirmed" && campaignId !== undefined) {
    return (
      <Card>
        <div className="space-y-3 text-center">
          <p className="text-sm text-good">Campaign created successfully!</p>
          <p className="text-xs text-ink-muted">Campaign #{campaignId.toString()}</p>
          <button
            type="button"
            onClick={() => router.push(`/campaign/${campaignId.toString()}`)}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-plane hover:opacity-90"
          >
            View Campaign
          </button>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <header>
        <h1 className="font-display text-2xl text-ink">Create a Campaign</h1>
        <p className="mt-1 text-xs text-ink-bold">
          Launch a performance-based campaign with escrowed rewards.
        </p>
      </header>

      {state.status === "error" ? (
        <Card>
          <ErrorState message={state.message} detail={state.detail} onRetry={reset} />
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Identity" subtitle="How this campaign is listed" />
        <div className="space-y-3">
          <Field
            label="Campaign name"
            value={draft.name}
            onChange={(v) => updateField("name", v)}
            error={issueFor("name")}
            hint={`Shown wherever the campaign is listed. Up to ${MAX_CAMPAIGN_NAME_LENGTH} characters, and unique — plain letters, digits and punctuation.`}
          />

          {/* Live availability, so a taken name is caught before a wallet prompt rather than as a
              reverted transaction. The contract re-checks on submit and is what actually decides. */}
          <p className="text-xs" role="status" aria-live="polite">
            {nameCheck.isIdle ? (
              <span className="text-ink-muted">
                {draft.name.length}/{MAX_CAMPAIGN_NAME_LENGTH} characters
              </span>
            ) : nameCheck.isLoading ? (
              <span className="text-ink-muted">Checking availability…</span>
            ) : nameCheck.isUnavailable ? (
              <span className="text-ink-muted">
                Could not reach the registry to check this name. Creation will still be rejected on
                chain if it is taken.
              </span>
            ) : nameCheck.isTaken ? (
              <span className="text-critical">
                Taken. Names ignore case and extra spaces, so a variant of an existing name counts as
                the same one.
              </span>
            ) : (
              <span className="text-good">
                Available · {draft.name.length}/{MAX_CAMPAIGN_NAME_LENGTH} characters
              </span>
            )}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Token & Pool" subtitle="ERC-20 token used for rewards" />
        <div className="space-y-3">
          <Field
            label="Token address"
            value={draft.token}
            onChange={(v) => updateField("token", v)}
            error={issueFor("token")}
          />

          {/* Resolved from the chain — the decimals that scale every amount below. */}
          <p className="text-xs" role="status" aria-live="polite">
            {token.isIdle ? (
              <span className="text-ink-muted">Enter a token address to read its decimals.</span>
            ) : token.isLoading ? (
              <span className="text-ink-muted">Reading token…</span>
            ) : token.isUnreadable ? (
              <span className="text-critical">
                No ERC-20 metadata at this address on the connected network. Amounts cannot be
                scaled safely, so campaign creation is blocked.
              </span>
            ) : (
              <span className="text-good">
                {token.meta?.symbol} · {token.meta?.decimals} decimals
              </span>
            )}
          </p>

          <Field
            label="Reward pool"
            value={draft.rewardPool}
            onChange={(v) => updateField("rewardPool", v)}
            error={issueFor("rewardPool")}
            hint={
              tokenDecimals === undefined
                ? "Total Rewards escrowed."
                : `Total escrow amount, in whole ${token.meta?.symbol}`
            }
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Campaign Window" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
          <DurationField
            label="Attribution window"
            seconds={draft.attributionWindow}
            onChange={(v) => updateField("attributionWindow", v)}
            error={issueFor("attributionWindow")}
            hint="How long a visit stays creditable"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Eligibility" />
        <Field
          label="Minimum reputation (0 = open to all)"
          value={draft.minReputation}
          onChange={(v) => updateField("minReputation", v)}
          error={issueFor("minReputation")}
        />
        <p className="mt-1.5 text-xs text-ink-muted">
          BoneyScore ranges from <b>0–{MAX_BONEY_SCORE.toLocaleString()}</b>. 
           Campaign settings [including this score cap] are <b>immutable</b> once created.
        </p>
      </Card>

      <Card>
        <CardHeader
          title="KPIs & Reward Tiers"
          subtitle={`${draft.kpis.length} KPI${draft.kpis.length === 1 ? "" : "s"}`}
          action={
            <button
              type="button"
              onClick={addKpi}
              className="text-xs text-brand hover:underline"
            >
              + Add KPI
            </button>
          }
        />

        {issueFor("kpis") ? (
          <p className="mb-3 text-xs text-critical">{issueFor("kpis")}</p>
        ) : null}

        <div className="space-y-4">
          {draft.kpis.map((kpi, i) => (
            <div key={i} className="rounded border border-hairline p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-ink">KPI {i + 1}</span>
                <button
                  type="button"
                  onClick={() => removeKpi(i)}
                  className="text-xs text-critical hover:underline"
                >
                  Remove
                </button>
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-ink-muted">Kind</label>
                    <select
                      value={kpi.kind}
                      onChange={(e) => updateKpi(i, {kind: e.target.value as KpiKind})}
                      className="w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink"
                    >
                      {KPI_KIND.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Field
                    label="Target (optional)"
                    value={kpi.target}
                    onChange={(v) => updateKpi(i, {target: v})}
                    error={issueFor(`kpis.${i}.target`)}
                  />
                </div>

                <Field
                  label="Verifier address (optional)"
                  value={kpi.verifier}
                  onChange={(v) => updateKpi(i, {verifier: v})}
                  error={issueFor(`kpis.${i}.verifier`)}
                />

                <label className="flex items-center gap-2 text-xs text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={kpi.aggregate}
                    onChange={(e) => updateKpi(i, {aggregate: e.target.checked})}
                  />
                  Aggregate-only (no rewards, analytics)
                </label>

                <EventSourceFields
                  kpiIndex={i}
                  value={kpi.eventSource}
                  onChange={(eventSource) => updateKpi(i, {eventSource})}
                  issueFor={issueFor}
                />

                {issueFor(`kpis.${i}.tiers`) ? (
                  <p className="text-xs text-critical">{issueFor(`kpis.${i}.tiers`)}</p>
                ) : null}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-ink-muted">
                      Tiers ({kpi.tiers.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => addTier(i)}
                      className="text-xs text-brand hover:underline"
                    >
                      + Add tier
                    </button>
                  </div>

                  {kpi.tiers.map((tier, j) => (
                    <div key={j} className="grid grid-cols-[1fr,1fr,auto] gap-2 items-end">
                      <Field
                        label={`Tier ${j + 1} threshold`}
                        value={tier.threshold}
                        onChange={(v) => updateTier(i, j, {threshold: v})}
                        error={issueFor(`kpis.${i}.tiers.${j}.threshold`)}
                      />
                      <Field
                        label="Reward"
                        value={tier.reward}
                        onChange={(v) => updateTier(i, j, {reward: v})}
                        error={issueFor(`kpis.${i}.tiers.${j}.reward`)}
                      />
                      <button
                        type="button"
                        onClick={() => removeTier(i, j)}
                        className="mb-1 text-xs text-critical hover:underline"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending(state) || tokenDecimals === undefined}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-plane hover:opacity-90 disabled:opacity-50"
        >
          {state.status === "preparing"
            ? "Awaiting signature..."
            : state.status === "submitted"
              ? "Mining..."
              : "Create Campaign"}
        </button>
        {state.status !== "idle" && state.status !== "error" ? (
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-hairline px-4 py-2 text-sm text-ink-secondary hover:bg-surface-hover"
          >
            Reset
          </button>
        ) : null}
      </div>
    </form>
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
  value,
  onChange,
  issueFor,
}: {
  kpiIndex: number;
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
    });
  };

  return (
    <div className="rounded border border-hairline bg-surface-2 p-2.5">
      <label className="flex items-center gap-2 text-xs text-ink-secondary">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? emptyEventSource() : undefined)}
        />
        Credit progress from on-chain events
      </label>

      {!enabled ? (
        <p className="mt-1 text-xs text-ink-muted">
          Leave off to report this KPI yourself. Turn on to name a contract and event an indexer
          reads instead.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">Preset</label>
            <select
              defaultValue=""
              onChange={(e) => applyPreset(e.target.value)}
              className="w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink"
            >
              <option value="">Custom…</option>
              {EVENT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Source contract"
            value={value.source}
            onChange={(v) => set({source: v})}
            error={issueFor(`${path}.source`)}
          />
          <Field
            label="Event signature"
            value={value.signature}
            onChange={(v) => set({signature: v})}
            error={issueFor(`${path}.signature`)}
            hint="Types only, no names or spaces — the topic is the keccak of this exact string."
          />

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-ink-muted">Actor topic</label>
              <select
                value={value.actorTopic}
                onChange={(e) => set({actorTopic: e.target.value})}
                className="w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink"
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-muted">Amount</label>
              <select
                value={value.amountMode}
                onChange={(e) => set({amountMode: e.target.value})}
                className="w-full rounded border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-ink"
              >
                <option value="count">Count events</option>
                <option value="dataWord0">First data word</option>
              </select>
            </div>
            <Field
              label="Scale"
              value={value.scale}
              onChange={(v) => set({scale: v})}
              error={issueFor(`${path}.scale`)}
            />
          </div>

          <p className="text-xs text-ink-muted">
            Which indexed topic holds the referral&rsquo;s address, and how much each event is worth.
            Scale divides the raw amount so tier thresholds stay small — 1e15 makes 0.001 of an
            18-decimal token one unit of progress.
          </p>

          {probe.findings.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {probe.findings.map((f, j) => (
                <div
                  key={j}
                  data-probe-severity={f.severity}
                  role="status"
                  className={`rounded px-2 py-1.5 text-xs ${
                    f.severity === "error"
                      ? "border border-red-300 bg-red-50 text-red-800"
                      : f.severity === "warn"
                        ? "border border-amber-200 bg-amber-50 text-amber-800"
                        : "border border-green-200 bg-green-50 text-green-800"
                  }`}
                >
                  {f.severity === "error" && <span className="font-semibold">Unusable: </span>}
                  {f.severity === "warn" && <span className="font-semibold">Unverified: </span>}
                  {f.message}
                </div>
              ))}
            </div>
          )}

          {probe.isLoading && (
            <p className="mt-2 text-xs text-ink-muted animate-pulse">
              Checking the chain for this contract and event…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function emptyEventSource(): EventSourceDraft {
  return {source: "", signature: "", actorTopic: "1", amountMode: "dataWord0", scale: "1"};
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
   *
   * Passed in rather than read from `Date.now()` here so the whole form judges the window against
   * one instant, and so this stays a pure render — a clock read inside the component would differ
   * between the server pass and the client pass and trip hydration.
   *
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
  const describedBy = error ? `${id}-error` : `${id}-hint`;

  // A future start is legal but costs real testing time: the campaign funds, activates, reads as
  // Active, and still rejects every report with `OutsideWindow` until it opens. Say so here rather
  // than letting it be discovered from a revert.
  const clockReady = nowSeconds !== undefined && nowSeconds > 0;
  const pending = clockReady && value > (nowSeconds as number);
  const delay = pending ? formatDuration(value - (nowSeconds as number)) : null;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-ink-muted">
        {label}
      </label>
      <input
        id={id}
        type="datetime-local"
        value={toDateTimeLocal(value)}
        onChange={(e) => onChange(fromDateTimeLocal(e.target.value))}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full rounded border px-2 py-1.5 text-xs text-ink bg-surface-2 ${
          error ? "border-critical" : "border-hairline"
        }`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-0.5 text-xs text-critical">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink-muted">
          {formatDateTime(value)} local
          {!clockReady ? null : pending ? (
            <>
              {" · "}
              <span className="text-warning">no reports credited for {delay}</span>
            </>
          ) : (
            <>{" · opens immediately"}</>
          )}
        </p>
      )}
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
}: {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const unitId = useId();
  const {value, unit} = splitDuration(seconds);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-ink-muted">
        {label}
      </label>
      <div className="flex gap-1.5">
        <input
          id={id}
          type="number"
          min="0"
          value={String(value)}
          onChange={(e) => onChange(joinDuration(Number(e.target.value), unit))}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full min-w-0 rounded border px-2 py-1.5 text-xs text-ink bg-surface-2 ${
            error ? "border-critical" : "border-hairline"
          }`}
        />
        {/* Its own accessible name — a shared label would leave the select reading as the number. */}
        <label htmlFor={unitId} className="sr-only">
          {label} unit
        </label>
        <select
          id={unitId}
          value={unit}
          onChange={(e) => onChange(joinDuration(value, e.target.value as DurationUnit))}
          className="rounded border border-hairline bg-surface-2 px-1.5 py-1.5 text-xs text-ink"
        >
          {DURATION_UNITS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-0.5 text-xs text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  type?: "text" | "number";
}) {
  // The label has to be *associated* with the input, not merely adjacent to it: a bare <label>
  // sibling leaves the input nameless to a screen reader, and to anything else querying by label.
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-ink-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full rounded border px-2 py-1.5 text-xs text-ink bg-surface-2 ${
          error ? "border-critical" : "border-hairline"
        }`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-0.5 text-xs text-critical">
          {error}
        </p>
      ) : null}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
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
