"use client";

import {useState, useCallback} from "react";
import {useRouter} from "next/navigation";
import {useAccount} from "wagmi";
import {Card, CardHeader} from "@/components/ui/Card";
import {ErrorState} from "@/components/ui/States";
import {useCreateCampaign, isPending} from "@/hooks/useWriteCampaign";
import {useTokenMeta} from "@/hooks/useTokenMeta";
import {useEventSourceProbe} from "@/hooks/useEventSourceProbe";
import {validateCampaignDraft, type CampaignDraft, type ValidationIssue, type KpiDraft, type TierDraft, type EventSourceDraft} from "@/lib/validation";
import {KPI_KIND, type KpiKind} from "@/lib/types";
import {AMOUNT_MODE, EVENT_PRESETS} from "@/lib/kpiSource";

export function CreateCampaignPage() {
  const {isConnected} = useAccount();
  const router = useRouter();
  const {state, create, reset, campaignId} = useCreateCampaign();

  const [draft, setDraft] = useState<CampaignDraft>(() => defaultDraft());
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  // Decimals come from the token contract, never from a form field — see useTokenMeta.
  const token = useTokenMeta(draft.token);
  const tokenDecimals = token.meta?.decimals;

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
      const found = validateCampaignDraft(draft, {tokenDecimals, nowSeconds});
      setIssues(found);

      if (found.length > 0) return;

      await create(draft, tokenDecimals);
    },
    [draft, tokenDecimals, create],
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
        <h1 className="font-display text-2xl text-ink">Create Campaign</h1>
        <p className="mt-1 text-xs text-ink-muted">
          Deploy a performance-based campaign with escrowed rewards
        </p>
      </header>

      {state.status === "error" ? (
        <Card>
          <ErrorState message={state.message} onRetry={reset} />
        </Card>
      ) : null}

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
                scaled safely, so creation is blocked.
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
                ? "Total escrow amount"
                : `Total escrow amount, in whole ${token.meta?.symbol}`
            }
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Campaign Window" />
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Start time (unix)"
            type="number"
            value={String(draft.startTime)}
            onChange={(v) => updateField("startTime", Number(v) || 0)}
          />
          <Field
            label="End time (unix)"
            type="number"
            value={String(draft.endTime)}
            onChange={(v) => updateField("endTime", Number(v) || 0)}
            error={issueFor("endTime")}
          />
          <Field
            label="Attribution window (seconds)"
            type="number"
            value={String(draft.attributionWindow)}
            onChange={(v) => updateField("attributionWindow", Number(v) || 0)}
            error={issueFor("attributionWindow")}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Eligibility" />
        <Field
          label="Minimum reputation (0 = open to all)"
          value={draft.minReputation}
          onChange={(v) => updateField("minReputation", v)}
        />
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
            Which indexed topic holds the user&rsquo;s address, and how much each event is worth.
            Scale divides the raw amount so tier thresholds stay small — 1e15 makes 0.001 of an
            18-decimal token one unit of progress.
          </p>
        </div>
      )}
    </div>
  );
}

function emptyEventSource(): EventSourceDraft {
  return {source: "", signature: "", actorTopic: "1", amountMode: "dataWord0", scale: "1"};
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
  return (
    <div>
      <label className="mb-1 block text-xs text-ink-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded border px-2 py-1.5 text-xs text-ink bg-surface-2 ${
          error ? "border-critical" : "border-hairline"
        }`}
      />
      {error ? <p className="mt-0.5 text-xs text-critical">{error}</p> : null}
      {hint && !error ? <p className="mt-0.5 text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

function defaultDraft(): CampaignDraft {
  const now = Math.floor(Date.now() / 1000);
  return {
    // Empty, not the zero address: the field starts blank so `useTokenMeta` sits idle instead of
    // reporting the zero address as an unreadable token before anything has been typed.
    token: "",
    rewardPool: "",
    startTime: now + 3600,
    endTime: now + 86400 * 30,
    attributionWindow: 86400 * 7,
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
