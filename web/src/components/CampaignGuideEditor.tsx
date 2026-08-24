"use client";

import {useId, useState} from "react";
import {usePublishGuide} from "@/hooks/usePublishGuide";
import {
  MAX_ACTION_LENGTH,
  MAX_SUMMARY_LENGTH,
  guideDraftFrom,
  guideFromDraft,
  validateGuideDraft,
  type GuideDraft,
  type ResolvedGuide,
} from "@/lib/campaignGuide";
import {KPI_KIND_LABEL} from "@/lib/types";
import type {KpiDetail} from "@/lib/campaignDetail";

/**
 * The project's own editor for its campaign guide.
 *
 * ## Why this exists separately from the create form
 *
 * Without it the guide is write-once and only for the fifteen seconds after `createCampaign` confirms:
 * navigate away from the confirmation screen and a mistyped link is permanent. That is a bad property
 * for a set of outbound links a referral is invited to click, and an especially bad one here — the
 * guide is the *only* part of a campaign that is not immutable, since everything on chain
 * (`CampaignConfig`, every `KpiSpec`, every tier) is fixed in the constructor. Making the one editable
 * thing uneditable would have been a choice, not a limitation.
 *
 * It reuses the whole write path — `usePublishGuide`, `/api/campaign-guide`, `guideStore` — so the
 * authorization story is identical: one signature from the project wallet, no transaction, no gas.
 *
 * ## Collapsed by default
 *
 * A project's default view of its own campaign is the same one everyone else gets. Opening the editor is
 * deliberate, and it seeds from the *resolved* guide — so a project editing a campaign whose guide comes
 * from the committed `CATALOG` starts from that text and takes it over by publishing, which is the
 * intended direction (see `resolveCampaignGuide`).
 */
export function CampaignGuideEditor({
  campaign,
  guide,
  kpis,
  onPublished,
}: {
  campaign: `0x${string}`;
  /** The guide as the page currently resolves it — catalog or stored. Seeds the draft. */
  guide: ResolvedGuide | null;
  kpis: readonly KpiDetail[];
  /** Re-read the store, so publishing updates the panel above rather than the next page load. */
  onPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  /*
    Seeded on open, not synchronised.

    There is no effect keeping this in step with `guide`, and there does not need to be: a closed
    editor's draft is never read, and opening it re-seeds from whatever the page has resolved by then.
    That also removes the failure mode a synchronising effect would have introduced — the store fetch
    settling mid-edit and overwriting what is being typed.
  */
  const [draft, setDraft] = useState<GuideDraft>(() => guideDraftFrom(guide, kpis.length));
  const publisher = usePublishGuide();

  const issues = validateGuideDraft(draft);
  const issueFor = (path: string) => issues.find((i) => i.path === path)?.message;
  const {state} = publisher;
  const busy = state.status === "signing" || state.status === "saving";

  const setField = (key: "summary" | "siteUrl", value: string) => {
    setDraft((prev) => ({...prev, [key]: value}));
  };

  const setKpi = (index: number, updates: Partial<GuideDraft["kpis"][number]>) => {
    setDraft((prev) => ({
      ...prev,
      kpis: prev.kpis.map((kpi, i) => (i === index ? {...kpi, ...updates} : kpi)),
    }));
  };

  const publish = async () => {
    await publisher.publish(campaign, guideFromDraft(draft));
    // Refetch regardless of outcome: a `501` still means the server's view is authoritative, and a
    // rejected signature leaves the store as it was, which is what the panel should show.
    onPublished();
  };

  if (!open) {
    return (
      <div className="mt-3 border-t border-hairline pt-3">
        <button
          className="text-xs text-brand hover:underline"
          onClick={() => {
            // Discard any half-finished edit and any stale outcome from a previous attempt, so the
            // editor opens on what is actually published rather than on the last thing typed.
            setDraft(guideDraftFrom(guide, kpis.length));
            publisher.reset();
            setOpen(true);
          }}
          type="button"
        >
          {guide ? "Edit campaign info" : "Add campaign info"}
        </button>
        <p className="mt-1 text-[11px] text-ink-muted">
          Only you can see this. Publishing takes one signature and no gas.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 border-t border-hairline pt-3">
      <EditorField
        error={issueFor("guide.summary")}
        hint={`What this campaign is about. ${draft.summary.trim().length}/${MAX_SUMMARY_LENGTH}`}
        label="Summary"
        onChange={(v) => setField("summary", v)}
        value={draft.summary}
      />
      <EditorField
        error={issueFor("guide.siteUrl")}
        hint="Your app or site. Full https:// address."
        label="Project link"
        onChange={(v) => setField("siteUrl", v)}
        value={draft.siteUrl}
      />

      {kpis.map((kpi, i) => (
        <div className="rounded border border-hairline bg-surface-2 p-2.5" key={kpi.index}>
          <p className="text-xs font-medium text-ink">
            KPI {kpi.index + 1} · {KPI_KIND_LABEL[kpi.spec.kind]}
          </p>
          <div className="mt-2 space-y-2.5">
            <EditorField
              error={issueFor(`guide.kpis.${i}.action`)}
              hint={`One line, up to ${MAX_ACTION_LENGTH} characters.`}
              label="Instruction"
              onChange={(v) => setKpi(i, {action: v})}
              value={draft.kpis[i]?.action ?? ""}
            />
            <EditorField
              error={issueFor(`guide.kpis.${i}.url`)}
              hint="Blank links the watched contract on the explorer instead."
              label="Action link"
              onChange={(v) => setKpi(i, {url: v})}
              value={draft.kpis[i]?.url ?? ""}
            />
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-plane hover:opacity-90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void publish()}
          type="button"
        >
          {state.status === "signing"
            ? "Awaiting signature…"
            : state.status === "saving"
              ? "Publishing…"
              : "Publish"}
        </button>
        <button
          className="rounded-md border border-hairline px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-hover"
          onClick={() => setOpen(false)}
          type="button"
        >
          Close
        </button>
        {/* Clearing every field is how a guide is withdrawn — see `guideStore.writeGuide`. */}
        <button
          className="text-xs text-ink-muted hover:text-ink hover:underline"
          onClick={() => setDraft(guideDraftFrom(null, kpis.length))}
          type="button"
        >
          Clear all
        </button>
      </div>

      <PublishOutcome onRetry={publisher.reset} state={state} />
    </div>
  );
}

/** The result of the last publish, including the one result the project has to act on. */
function PublishOutcome({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: ReturnType<typeof usePublishGuide>["state"];
}) {
  if (state.status === "saved") {
    return <p className="text-xs text-good">Published.</p>;
  }

  if (state.status === "cleared") {
    return <p className="text-xs text-ink-muted">Withdrawn — every field was empty.</p>;
  }

  if (state.status === "error") {
    return (
      <p className="text-xs text-warning">
        Not published: {state.message}{" "}
        <button className="underline hover:text-ink" onClick={onRetry} type="button">
          Dismiss
        </button>
      </p>
    );
  }

  if (state.status === "unwritable") {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-warning">{state.message}</p>
        {/* The entry itself, because the alternative is asking a project to retype prose it just wrote. */}
        <pre className="max-h-40 overflow-auto rounded border border-hairline bg-surface-1 p-2 text-[10px] leading-relaxed text-ink-secondary">
          {JSON.stringify(state.entry, null, 2)}
        </pre>
      </div>
    );
  }

  return null;
}

/**
 * A labelled text input.
 *
 * Its own rather than shared with `CreateCampaignPage`'s: that one is private to a form page laid out in
 * full-width cards, and lifting it into a shared module for two callers would mean a component whose API
 * has to serve both layouts. The label association is the part that matters and is duplicated exactly —
 * a bare `<label>` sibling leaves the input nameless to a screen reader.
 */
function EditorField({
  error,
  hint,
  label,
  onChange,
  value,
}: {
  error?: string;
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label className="mb-1 block text-xs text-ink-muted" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded border px-2 py-1.5 text-xs text-ink bg-surface-2 ${
          error ? "border-critical" : "border-hairline"
        }`}
        id={id}
        onChange={(e) => onChange(e.target.value)}
        type="text"
        value={value}
      />
      {error ? (
        <p className="mt-0.5 text-xs text-critical" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-0.5 text-xs text-ink-muted" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
