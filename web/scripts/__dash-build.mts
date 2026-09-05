/**
 * Throwaway: renders `__dash-data.json` into `web/public/verification-dashboard.html` — the
 * all-campaigns verification dashboard. Every figure on the page comes from the JSON, so the page
 * can be regenerated after any fixture change by re-running the collector then this.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {KPI_KIND, CAMPAIGN_STATUS} from "../src/lib/types";

type Row = Record<string, never>;
const data = JSON.parse(readFileSync(new URL("./__dash-data.json", import.meta.url), "utf8")) as Row;
const campaigns = data.campaigns as unknown as Row[];

const esc = (v: unknown) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: unknown, n = 8) => (typeof a === "string" ? `${a.slice(0, n)}…` : "—");
const num = (v: unknown) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US"));

/** Formats an 18-decimal token amount, dropping the fraction because every fixture reward is whole. */
const tok = (wei: unknown) => {
  if (wei === null || wei === undefined) return "—";
  const whole = BigInt(wei as string) / 10n ** 18n;
  return whole.toLocaleString("en-US");
};

const ACTOR = ["data", "T1", "T2", "T3"];
const MODE = ["count", "dataWord0", "dataWord1", "dataWord2"];
// Both mirror Solidity enums, so take them from the module that already mirrors them.
const KIND = KPI_KIND;
const STATUS = CAMPAIGN_STATUS;
const TOKENS: Record<string, string> = {
  "0x2755562471B5f6239722ab164d126260F4D8dCc2": "bUSD",
  "0x0d442EC7BdDB06b531DCA3Dd39ABaFf554170776": "GYND",
};
const symbolOf = (t: unknown) => TOKENS[t as string] ?? short(t, 10);
const SOURCES: Record<string, string> = {
  "0x4200000000000000000000000000000000000006": "WETH",
  "0x3bdD104560Ae0F0cC4360E691Cdcd972F4CD1193": "OpenMintNFT",
  "0x7B47daC59075aF44046795BA347EC872D5409263": "GYND/cbBTC pool",
  "0x5c0E023Ce4A353e5Cd9a43E28D2879Cb9e876865": "GYND staking",
  "0x76998e42B789d81004f006402b6c62a8BDCAfD5b": "position manager",
  "0x46880b404CD35c165EDdefF7421019F8dD25F4Ad": "WETH/USDC pool",
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e": "USDC",
  "0xe04C5185eDd4C9b1c91e31c790843c335766258e": "AttributionRegistry",
  "0x86B7b22aEd09452232Ca1A072db5BE7a837F06fc": "Gyndore campaign",
};
const sourceName = (a: unknown) => SOURCES[a as string] ?? short(a, 10);

const B = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));

/** Per-referral agreement between the layers, and the one word for it. */
type Ref = {
  user: string; viaWallet: string | null; claim: bigint; graph: bigint | null;
  ceiling: bigint | null; ceilingRaw: bigint | null; rescan: bigint | null; logs: number | null;
  creditedToLive: bigint; lastReportBlock: bigint; verdict: string; graphDrift: boolean;
};

const classify = (claim: bigint, rescan: bigint | null, ceiling: bigint | null, gated: boolean) => {
  if (rescan !== null) {
    if (claim > rescan) return "over";
    if (claim < rescan) return "under";
    if (claim === 0n) return "idle";
    return "exact";
  }
  if (gated && ceiling !== null) {
    if (ceiling === 0n && claim > 0n) return "blocked";
    if (ceiling < claim) return "capped";
  }
  return claim === 0n ? "idle" : "unchecked";
};

const refsOf = (kpi: Row): Ref[] => (kpi.referrals as unknown as Row[]).map((r) => {
  const claim = B(r.credited)!;
  const rescan = B(r.rescanUnits);
  const ceiling = B(r.ceilingScaled);
  const graph = B(r.graphCredited);
  return {
    user: r.user as unknown as string,
    viaWallet: (r.viaWallet ?? null) as unknown as string | null,
    claim, graph, ceiling, ceilingRaw: B(r.ceilingRaw), rescan,
    logs: (r.rescanLogs ?? null) as unknown as number | null,
    creditedToLive: B(r.creditedToLive)!,
    lastReportBlock: B(r.lastReportBlock)!,
    graphDrift: graph !== null && graph !== claim,
    verdict: classify(claim, rescan, ceiling, kpi.gated as unknown as boolean),
  };
});

/** Rolls the referral verdicts into the one word the matrix shows for the whole KPI. */
const kpiVerdict = (refs: Ref[], kpi: Row) => {
  const any = (v: string) => refs.some((r) => r.verdict === v);
  const claimed = refs.reduce((s, r) => s + r.claim, 0n);
  const elsewhere = refs.reduce((s, r) => s + (r.ceiling ?? 0n) + (r.rescan ?? 0n), 0n);
  if (claimed === 0n) {
    if (!kpi.source) return "no source";
    return elsewhere > 0n ? "unclaimed" : "dormant";
  }
  if (any("over")) return "inflated";
  if (any("blocked")) return "blocked";
  if (any("under")) return "behind";
  if (any("capped")) return "capped";
  if (refs.some((r) => r.graphDrift)) return "graph drift";
  return any("exact") ? "exact" : "unchecked";
};

const TONE: Record<string, string> = {
  exact: "pass", inflated: "bad", behind: "warn", blocked: "bad", capped: "warn",
  dormant: "idle", "no source": "idle", unchecked: "idle", "graph drift": "bad", unclaimed: "bad",
  over: "bad", under: "warn", idle: "idle", slack: "pass",
};

// Reuse the sibling page's validated token block rather than restating 180 lines of it.
const precedent = readFileSync(new URL("../public/gyndore-verification.html", import.meta.url), "utf8");
const baseStyles = precedent.match(/<style>([\s\S]*?)<\/style>/)![1]!;

const EXTRA = `
  /* ── dashboard-only: the matrix, layer legend and campaign cards ────────── */
  .lay { display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); gap: 1px; background: var(--rule); }
  .lay > div { background: var(--surface); padding: 12px 14px 13px; display: flex; flex-direction: column; gap: 5px; }
  .lay .k { font-family: var(--display); font-size: 10.5px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--accent-ink); }
  .lay p { font-size: 12.5px; color: var(--ink-soft); max-width: none; }
  .lay .no { font-size: 11.5px; color: var(--ink-faint); font-style: italic; }

  .badge { display: inline-block; font-family: var(--display); font-size: 10px; font-weight: 700;
    letter-spacing: .07em; text-transform: uppercase; padding: 2px 6px; border-radius: 2px; }
  .b-pass { background: var(--pass-soft); color: var(--pass); }
  .b-warn { background: var(--warn-soft); color: var(--warn); }
  .b-bad  { background: var(--warn-soft); color: var(--warn); border: 1px solid var(--warn); }
  .b-idle { background: var(--idle-soft); color: var(--idle); }

  .camp { display: flex; flex-direction: column; gap: 14px; padding: 24px 0; border-top: 1px solid var(--rule); }
  .camp-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
  .camp-head .id { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
  .kpi { display: flex; flex-direction: column; gap: 9px; padding: 14px 0 0; border-top: 1px dashed var(--rule-soft); }
  .kpi-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; font-family: var(--mono); font-size: 12.5px; }
  .kpi-head .kn { font-family: var(--display); font-size: 13.5px; font-weight: 650; letter-spacing: -.005em; }
  .sig { font-family: var(--mono); font-size: 11.5px; color: var(--ink-faint); overflow-wrap: anywhere; }
  .note { font-size: 12.5px; color: var(--ink-soft); max-width: 84ch; }
  .note b { color: var(--ink); font-weight: 600; }
  td.gap { color: var(--warn); font-weight: 700; }
  .tl { display: flex; flex-direction: column; border: 1px solid var(--rule); background: var(--surface); }
  .tl-row { display: grid; grid-template-columns: 108px 132px 1fr; gap: 0 16px; padding: 8px 14px;
    border-bottom: 1px solid var(--rule-soft); font-family: var(--mono); font-size: 12px; }
  .tl-row:last-child { border-bottom: none; }
  .tl-row .ev { font-weight: 700; }
  .tl-row .ar { color: var(--ink-faint); overflow-wrap: anywhere; }
  .tl-row.cfg { background: var(--surface-sunk); }
  @media (max-width: 720px) { .tl-row { grid-template-columns: 1fr; gap: 3px; } }
`;

const out: string[] = [];
const w = (...lines: string[]) => out.push(...lines);

// ── aggregates the masthead spends its big numbers on ─────────────────────────
const allKpis = campaigns.flatMap((c) => (c.kpis as unknown as Row[]).map((k) => ({c, k, refs: refsOf(k)})));
const rescanned = allKpis.filter((r) => r.refs.some((x) => x.rescan !== null)).length;
const gatedCount = allKpis.filter((r) => r.k.gated).length;
const paidTotal = campaigns.reduce((s, c) => s + BigInt(c.paidOut as unknown as string), 0n);
const promoterCount = campaigns.reduce((s, c) => s + (c.promoters as unknown as Row[]).length, 0);
const graphDrifts = allKpis.filter((r) => r.refs.some((x) => x.graphDrift)).length;
const sub = data.subgraph as unknown as Row;

w(`<title>Boneyard Verification Dashboard</title>`,
  `<link rel="preconnect" href="https://fonts.googleapis.com">`,
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..112,400..700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap">`,
  `<style>${baseStyles}${EXTRA}</style>`,
  ``,
  `<div class="page">`,
  ``,
  `  <header class="masthead">`,
  `    <div class="mast-top">`,
  `      <h1>Every campaign, every layer that could disagree</h1>`,
  `      <span class="pill pill-${graphDrifts ? "warn" : "pass"}"><span class="dot"></span>`,
  `        ${graphDrifts ? `${graphDrifts} graph drift` : "subgraph reproduces the chain"}</span>`,
  `      <span class="pill pill-${Number(sub.lag) > 300 ? "warn" : "pass"}"><span class="dot"></span>`,
  `        subgraph lag ${num(sub.lag)} ${Number(sub.lag) === 1 ? "block" : "blocks"}</span>`,
  `    </div>`,
  `    <p>Five layers read the same campaigns. Four of them are supposed to produce the same number, and`,
  `    the fifth — escrow — is supposed to follow from it. This page puts them in one row per KPI so the`,
  `    disagreements are the thing you see first, not something you have to go looking for.</p>`,
  `    <div class="ident">`,
  `      <span><b>registry</b> ${esc(data.registry)}</span>`,
  `      <span><b>reporter</b> ${esc(data.reporter ?? "—")}</span>`,
  `      <span><b>verifier</b> ${esc(data.eventMetric ?? "—")}</span>`,
  `      <span><b>head</b> ${num(data.head)}</span>`,
  `      <span><b>read</b> ${esc(String(data.collectedAt).slice(0, 19).replace("T", " "))}Z</span>`,
  `    </div>`,
  `  </header>`,
  ``,
  `  <div class="figures">`,
  `    <div class="fig"><span class="v">${campaigns.length}</span><span class="u">campaigns, all Active</span><span class="k">registry</span></div>`,
  `    <div class="fig"><span class="v">${allKpis.length}</span><span class="u">${gatedCount} gated, ${allKpis.length - gatedCount} ungated</span><span class="k">KPIs</span></div>`,
  `    <div class="fig"><span class="v">${rescanned}</span><span class="u">of ${allKpis.length} re-scanned independently</span><span class="k">checked</span></div>`,
  `    <div class="fig"><span class="v">${tok(paidTotal)}</span><span class="u">paid from escrow, ${promoterCount} promoters</span><span class="k">settled</span></div>`,
  `  </div>`);

w(``,
  `  <section>`,
  `    <span class="eyebrow">The layers</span>`,
  `    <h2 style="margin: 6px 0 14px">Five readers, one of them independent</h2>`,
  `    <div class="lay">`,
  `      <div><span class="k">Claim</span><p><span class="mono">userCreditedOf</span> — what the project reported and the chain credited, segmented per action block.</p><span class="no">blind to whether it was true</span></div>`,
  `      <div><span class="k">Ceiling</span><p><span class="mono">observedProgressOf</span> — what the relayer saw in the logs, unfiltered. Gated KPIs only.</p><span class="no">blind to the KPI's topic filter, and absent on ${allKpis.length - gatedCount} of ${allKpis.length} KPIs</span></div>`,
  `      <div><span class="k">Subgraph</span><p><span class="mono">Credit</span> and <span class="mono">TierPayout</span> folded — the whole credited history, in two POSTs instead of ${allKpis.length * 3} calls.</p><span class="no">blind to the verifier: no data source watches it</span></div>`,
  `      <div><span class="k">Re-scan</span><p><span class="mono">eth_getLogs</span> replayed against each KPI's own <span class="mono">params</span>, narrowed to that campaign's referrals.</p><span class="no">the only column not produced by the code it checks</span></div>`,
  `      <div><span class="k">Escrow</span><p><span class="mono">paidOut</span> and <span class="mono">remainingPool</span> — money that actually moved.</p><span class="no">blind to which KPI earned it</span></div>`,
  `    </div>`,
  `  </section>`);

// ── the matrix: one row per KPI, all five layers side by side ─────────────────
w(``,
  `  <section>`,
  `    <span class="eyebrow">The matrix</span>`,
  `    <h2 style="margin: 6px 0 6px">${allKpis.length} KPIs, and where the layers part company</h2>`,
  `    <p class="note" style="margin-bottom: 14px">Totals are campaign-wide sums across referrals, in the`,
  `    KPI's own scaled units. <b>Claim</b> is what the chain credited; <b>ceiling</b> what the relayer`,
  `    observed; <b>graph</b> the subgraph's fold of <span class="mono">Credit</span>; <b>re-scan</b> an`,
  `    independent replay. A gated KPI's ceiling is read unfiltered, so a ceiling above the claim is`,
  `    expected and harmless — only a ceiling <em>below</em> it binds.</p>`,
  `    <div class="scroll"><table>`,
  `      <thead><tr><th>Campaign</th><th>KPI</th><th>Source</th><th>Gate</th>`,
  `        <th class="r">Claim</th><th class="r">Ceiling</th><th class="r">Graph</th><th class="r">Re-scan</th>`,
  `        <th class="r">Logs</th><th>Verdict</th></tr></thead>`,
  `      <tbody>`);

for (const {c, k, refs} of allKpis) {
  const v = kpiVerdict(refs, k);
  const claim = refs.reduce((s, r) => s + r.claim, 0n);
  const graph = refs.reduce((s, r) => s + (r.graph ?? 0n), 0n);
  const ceiling = k.gated ? refs.reduce((s, r) => s + (r.ceiling ?? 0n), 0n) : null;
  const anyRescan = refs.some((r) => r.rescan !== null);
  const rescan = anyRescan ? refs.reduce((s, r) => s + (r.rescan ?? 0n), 0n) : null;
  const logs = anyRescan ? refs.reduce((s, r) => s + BigInt(r.logs ?? 0), 0n) : null;
  const src = k.source as unknown as Row | null;
  const cls = (a: bigint, b: bigint | null) => (b === null ? "" : a === b ? " agree" : " gap");
  w(`        <tr>`,
    `          <td class="t">${esc(c.name)}</td>`,
    `          <td>${k.index} <span class="zero">${esc(KIND[Number(k.kind)] ?? k.kind)}</span></td>`,
    `          <td class="t">${src ? `${esc(sourceName(src.source))} <span class="zero">${esc(ACTOR[Number(src.actorTopic)])}·${esc(MODE[Number(src.amountMode)])}</span>` : "<span class=\"zero\">none</span>"}</td>`,
    `          <td>${k.gated ? "<span class=\"badge b-pass\">guarded</span>" : "<span class=\"badge b-idle\">open</span>"}</td>`,
    `          <td class="r">${num(claim)}</td>`,
    `          <td class="r${ceiling === null ? " zero" : ceiling < claim && ceiling !== 0n ? " gap" : ""}">${ceiling === null ? "—" : num(ceiling)}</td>`,
    `          <td class="r${cls(graph, claim)}">${num(graph)}</td>`,
    `          <td class="r${rescan === null ? " zero" : cls(claim, rescan)}">${rescan === null ? "—" : num(rescan)}</td>`,
    `          <td class="r zero">${logs === null ? "—" : num(logs)}</td>`,
    `          <td><span class="badge b-${TONE[v]}">${esc(v)}</span></td>`,
    `        </tr>`);
}
w(`      </tbody>`, `    </table></div>`, `  </section>`);

// ── checkpoints: the observation layer's position, per gated KPI ──────────────
const gated = allKpis.filter((r) => r.k.gated);
w(``,
  `  <section>`,
  `    <span class="eyebrow">Checkpoints</span>`,
  `    <h2 style="margin: 6px 0 6px">Where the relayer stopped, and what that leaves unobserved</h2>`,
  `    <p class="note" style="margin-bottom: 14px"><span class="mono">lastScannedBlock</span> is keyed`,
  `    <span class="mono">(campaign, kpi, epoch)</span> and lives on chain, because the relayer process keeps no`,
  `    state. Totals are <b>additive</b> — a batch writes stored + delta — so re-folding a range that is`,
  `    already behind the checkpoint counts it twice. That is why the resume point is`,
  `    <span class="mono">checkpoint + 1</span> and why a rescan is refused rather than clamped.</p>`,
  `    <div class="scroll"><table>`,
  `      <thead><tr><th>Campaign</th><th>KPI</th><th class="r">Window start</th><th class="r">Checkpoint</th>`,
  `        <th class="r">Window end</th><th class="r">Unscanned to head</th><th class="r">Epoch</th><th>Next pass</th></tr></thead>`,
  `      <tbody>`);
for (const {c, k} of gated) {
  const relay = k.relay as unknown as Row | null;
  const cp = B(k.checkpoint) ?? 0n;
  const wEnd = B(relay?.windowEndBlock) ?? 0n;
  const wStart = B(relay?.windowStartBlock) ?? 0n;
  const head = BigInt(data.head as unknown as string);
  const to = (head - 5n < wEnd ? head - 5n : wEnd);
  const unscanned = to > cp ? to - cp : 0n;
  const verdict = cp >= wEnd ? "window closed" : to <= cp ? "nothing to fold yet" : `resumes at ${num(cp + 1n)}`;
  w(`        <tr><td class="t">${esc(c.name)}</td><td>${k.index}</td>`,
    `          <td class="r zero">${num(wStart)}</td><td class="r">${num(cp)}</td><td class="r zero">${num(wEnd)}</td>`,
    `          <td class="r${unscanned > 20000n ? " gap" : ""}">${num(unscanned)}</td>`,
    `          <td class="r zero">${esc(relay?.epoch ?? "—")}</td><td class="t">${esc(verdict)}</td></tr>`);
}
w(`      </tbody>`, `    </table></div>`, `  </section>`);

// ── the timeline: verifier events grouped into relay passes ──────────────────
const history = (data.checkpointHistory ?? []) as unknown as Row[];
if (history.length) {
  const nameOf = (addr: unknown) => campaigns.find((c) =>
    (c.address as unknown as string).toLowerCase() === String(addr).toLowerCase())?.name ?? short(addr);
  // `reportBatch` emits the per-user totals and the checkpoint in one transaction, so a transaction
  // is a pass. A pass with no totals folded an empty range and only moved the checkpoint.
  const passes = new Map<string, Row[]>();
  for (const h of history) {
    const tx = h.tx as unknown as string;
    if (!passes.has(tx)) passes.set(tx, []);
    passes.get(tx)!.push(h);
  }
  const wrote: {block: bigint; campaign: unknown; kpi: unknown; users: Row[]; cp: unknown}[] = [];
  const empty: {campaign: unknown; kpi: unknown; count: number; first: bigint; last: bigint; cp: unknown}[] = [];
  const configured: Row[] = [];
  for (const events of passes.values()) {
    const totals = events.filter((e) => e.event === "VerifiedTotalReported");
    const cps = events.filter((e) => e.event === "CheckpointAdvanced");
    for (const c of events.filter((e) => e.event === "KpiConfigured" || e.event === "KpiTotalsInvalidated")) configured.push(c);
    const a = (totals[0] ?? cps[0])?.args as unknown as Row | undefined;
    if (!a) continue;
    if (totals.length) {
      wrote.push({block: BigInt(events[0]!.blockNumber as unknown as string), campaign: a.campaign,
        kpi: a.kpiIndex, users: totals, cp: (cps[0]?.args as unknown as Row | undefined)?.scannedUpToBlock});
    } else {
      const key = `${a.campaign}-${a.kpiIndex}`;
      const block = BigInt(events[0]!.blockNumber as unknown as string);
      const row = empty.find((e) => `${e.campaign}-${e.kpi}` === key);
      const cp = (cps[0]!.args as unknown as Row).scannedUpToBlock;
      if (row) { row.count++; row.last = block; row.cp = cp; }
      else empty.push({campaign: a.campaign, kpi: a.kpiIndex, count: 1, first: block, last: block, cp});
    }
  }
  wrote.sort((a, b) => Number(a.block - b.block));
  w(``,
    `  <section>`,
    `    <span class="eyebrow">Timeline</span>`,
    `    <h2 style="margin: 6px 0 6px">${passes.size} relay passes, ${wrote.length} of which found anything</h2>`,
    `    <p class="note" style="margin-bottom: 14px">This is the only history on the page that no subgraph`,
    `    holds — <span class="mono">subgraph.yaml</span> declares no data source for the verifier, so the`,
    `    observation layer's past exists solely in logs. One transaction is one pass, because`,
    `    <span class="mono">reportBatch</span> moves the totals and the checkpoint together or not at all. The`,
    `    ${passes.size - wrote.length} passes not listed folded an empty range and advanced the checkpoint only —`,
    `    which is the loop working, not failing.</p>`,
    `    <div class="tl">`);
  for (const c of configured) {
    const a = c.args as unknown as Row;
    const detail = c.event === "KpiConfigured"
      ? `${String(a.eventSignature).split("(")[0]} on ${sourceName(a.targetContract)}, actor param ${a.userParamIndex}, window ${num(a.windowStartBlock)}–${num(a.windowEndBlock)}`
      : `epoch → ${num(a.epoch)}, every total before it abandoned`;
    w(`      <div class="tl-row cfg"><span>${num(c.blockNumber)}</span>`,
      `        <span class="ev">${esc(String(c.event).replace(/([A-Z])/g, " $1").trim())}</span>`,
      `        <span class="ar">${esc(nameOf(a.campaign))} kpi ${esc(a.kpiIndex)} — ${esc(detail)}</span></div>`);
  }
  for (const p of wrote) {
    const sum = p.users.reduce((s2, u) => s2 + BigInt((u.args as unknown as Row).verifiedTotal as unknown as string), 0n);
    w(`      <div class="tl-row"><span>${num(p.block)}</span>`,
      `        <span class="ev">wrote ${p.users.length} ${p.users.length === 1 ? "ceiling" : "ceilings"}</span>`,
      `        <span class="ar">${esc(nameOf(p.campaign))} kpi ${esc(p.kpi)} — totals now sum ${num(sum)} raw, checkpoint → ${num(p.cp)}</span></div>`);
  }
  for (const e of empty) {
    w(`      <div class="tl-row"><span class="zero">${num(e.first)}–${num(e.last)}</span>`,
      `        <span class="ev zero">${num(e.count)} empty ${e.count === 1 ? "pass" : "passes"}</span>`,
      `        <span class="ar">${esc(nameOf(e.campaign))} kpi ${esc(e.kpi)} — no matching log in range, checkpoint walked to ${num(e.cp)}</span></div>`);
  }
  w(`    </div>`, `  </section>`);
}

// ── per campaign: the referral-level detail behind every matrix row ───────────
w(``,
  `  <section>`,
  `    <span class="eyebrow">Campaign by campaign</span>`,
  `    <h2 style="margin: 6px 0 6px">Every referral, every layer</h2>`,
  `    <p class="note">One block per campaign. <b>Claim</b> is <span class="mono">userCreditedOf</span>;`,
  `    <b>to live</b> is <span class="mono">creditedToOf</span> against the promoter who holds the referral`,
  `    <em>now</em> — a gap between them is credit segmented to an earlier promoter, which is correct, not a`,
  `    loss. <b>Last report</b> is the block the claim watermark sits at.</p>`);

for (const c of campaigns) {
  const kpis = c.kpis as unknown as Row[];
  const promoters = c.promoters as unknown as Row[];
  const sym = symbolOf(c.token);
  const refCount = kpis[0] ? (kpis[0].referrals as unknown as Row[]).length : 0;
  w(``,
    `    <div class="camp">`,
    `      <div class="camp-head">`,
    `        <h2>${esc(c.name)}</h2>`,
    `        <span class="id">id ${c.id} · ${esc(c.address)}</span>`,
    `        <span class="badge b-${kpis.some((k) => k.gated) ? "pass" : "idle"}">${kpis.some((k) => k.gated) ? "guarded KPIs" : "ungated"}</span>`,
    `      </div>`,
    `      <div class="readout">`,
    `        <div class="ro"><span class="k">status</span><span class="v">${esc(STATUS[Number(c.status)] ?? c.status)}</span></div>`,
    `        <div class="ro"><span class="k">escrow paid</span><span class="v">${tok(c.paidOut)} <em>of ${tok(c.rewardPool)} ${esc(sym)}</em></span></div>`,
    `        <div class="ro"><span class="k">remaining</span><span class="v">${tok(c.remainingPool)} <em>${esc(sym)}</em></span></div>`,
    `        <div class="ro"><span class="k">min reputation</span><span class="v">${num(c.minReputation)}</span></div>`,
    `        <div class="ro"><span class="k">attribution window</span><span class="v">${Number(c.attributionWindow) / 86400} <em>days</em></span></div>`,
    `        <div class="ro"><span class="k">promoters</span><span class="v">${promoters.length} <em>${refCount} referrals</em></span></div>`,
    `        <div class="ro"><span class="k">first touch</span><span class="v">${num(c.firstTouchBlock)}</span></div>`,
    `        <div class="ro"><span class="k">graph rows</span><span class="v">${num((c.graphTotals as unknown as Row).credits)} <em>credits, ${num((c.graphTotals as unknown as Row).payouts)} payouts</em></span></div>`,
    `      </div>`);

  for (const k of kpis) {
    const refs = refsOf(k);
    const v = kpiVerdict(refs, k);
    const src = k.source as unknown as Row | null;
    const relay = k.relay as unknown as Row | null;
    const tiers = k.tiers as unknown as Row[];
    w(`      <div class="kpi">`,
      `        <div class="kpi-head">`,
      `          <span class="kn">KPI ${k.index} · ${esc(KIND[Number(k.kind)] ?? k.kind)}</span>`,
      `          <span class="badge b-${TONE[v]}">${esc(v)}</span>`,
      `          <span class="zero">total ${num(k.totalProgress)} · tiers ${tiers.map((t) => num(t.threshold)).join(" / ")} → ${tiers.map((t) => tok(t.reward)).join(" / ")} ${esc(sym)}</span>`,
      `        </div>`);
    if (src) {
      w(`        <div class="sig">${esc(sourceName(src.source))} <span class="zero">${esc(src.source)}</span>`,
        `          · topic0 ${esc(String(src.topic0).slice(0, 12))}… · actor ${esc(ACTOR[Number(src.actorTopic)])}`,
        `          · amount ${esc(MODE[Number(src.amountMode)])} · scale ${num(src.scale)}`,
        `          ${src.filterTopic ? `· filter ${esc(ACTOR[Number(src.filterTopic)])} = ${esc(String(src.filterValue).replace(/^0x0+(?=.)/, "0x"))}` : "· <em>no filter</em>"}</div>`);
    }
    if (relay) {
      w(`        <div class="sig">relay config: <b>${esc(String(relay.eventSignature))}</b>`,
        `          · actor param ${esc(relay.userParamIndex)} · ${Number(relay.aggregation) === 0 ? "COUNT" : "SUM"}`,
        `          · scale ${num(relay.scale)} · window ${num(relay.windowStartBlock)}–${num(relay.windowEndBlock)}`,
        `          · checkpoint ${num(k.checkpoint)}</div>`);
    }

    const active = refs.filter((r) => r.claim > 0n || (r.rescan ?? 0n) > 0n || (r.ceiling ?? 0n) > 0n);
    if (active.length) {
      w(`        <div class="scroll"><table>`,
        `          <thead><tr><th>Referral</th><th>Via promoter</th><th class="r">Claim</th><th class="r">To live</th>`,
        `            <th class="r">Graph</th>${k.gated ? `<th class="r">Ceiling</th><th class="r">Raw</th>` : ""}`,
        `            <th class="r">Re-scan</th><th class="r">Logs</th><th class="r">Last report</th><th></th></tr></thead>`,
        `          <tbody>`);
      for (const r of active) {
        const gap = r.rescan !== null && r.claim !== r.rescan;
        w(`            <tr>`,
          `              <td>${short(r.user, 10)}</td>`,
          `              <td>${r.viaWallet ? short(r.viaWallet, 8) : "<span class=\"zero\">—</span>"}</td>`,
          `              <td class="r${gap ? " gap" : r.rescan !== null ? " agree" : ""}">${num(r.claim)}</td>`,
          `              <td class="r${r.creditedToLive === r.claim ? "" : " zero"}">${num(r.creditedToLive)}</td>`,
          `              <td class="r${r.graphDrift ? " gap" : " agree"}">${r.graph === null ? "—" : num(r.graph)}</td>`,
          k.gated ? `              <td class="r${r.ceiling !== null && r.ceiling < r.claim ? " gap" : ""}">${r.ceiling === null ? "—" : num(r.ceiling)}</td>` : "",
          k.gated ? `              <td class="r zero">${r.ceilingRaw === null ? "—" : num(r.ceilingRaw)}</td>` : "",
          `              <td class="r">${r.rescan === null ? "<span class=\"zero\">—</span>" : num(r.rescan)}</td>`,
          `              <td class="r zero">${r.logs === null ? "—" : num(r.logs)}</td>`,
          `              <td class="r zero">${num(r.lastReportBlock)}</td>`,
          `              <td><span class="badge b-${TONE[r.verdict]}">${esc(r.verdict)}</span></td>`,
          `            </tr>`);
      }
      w(`          </tbody>`, `        </table></div>`);
    } else {
      w(`        <p class="note"><b>Nothing credited, nothing observed, nothing in the logs.</b>`,
        `        ${src ? "An OR-filtered re-scan of every referral against this KPI's own params returns the empty set — not a low count. From outside, \"nobody acted\" and \"the actor slot is wrong\" look identical." : "This KPI declares no event source, so no scan can check it."}</p>`);
    }

    const settled = (k.promoterRows as unknown as Row[]).filter((p) => BigInt(p.progress as unknown as string) > 0n);
    if (settled.length) {
      w(`        <div class="scroll"><table>`,
        `          <thead><tr><th>Promoter</th><th class="r">Progress</th><th class="r">Graph progress</th>`,
        `            <th class="r">Tiers</th><th class="r">Graph tiers</th><th class="r">Paid</th></tr></thead>`,
        `          <tbody>`);
      for (const p of settled) {
        const drift = p.progress !== p.graphProgress;
        w(`            <tr><td>${short(p.wallet, 10)}</td>`,
          `              <td class="r">${num(p.progress)}</td>`,
          `              <td class="r${drift ? " gap" : " agree"}">${num(p.graphProgress)}</td>`,
          `              <td class="r">${num(p.settledTiers)}</td>`,
          `              <td class="r${Number(p.settledTiers) === Number(p.graphTiers) ? " agree" : " gap"}">${num(p.graphTiers)}</td>`,
          `              <td class="r">${tok(p.graphPaid)} <span class="zero">${esc(sym)}</span></td></tr>`);
      }
      w(`          </tbody>`, `        </table></div>`);
    }
    w(`      </div>`);
  }
  w(`    </div>`);
}
w(`  </section>`);

// ── what the subgraph can and cannot answer, from its own records ─────────────
const spawned = (data.spawnedSources ?? []) as unknown as Row[];
const unsupported = (data.unsupportedSources ?? []) as unknown as Row[];
const observedKpis = allKpis.filter(({k}) => {
  const src = k.source as unknown as Row | null;
  if (!src) return false;
  return spawned.some((sp) => String(sp.address).toLowerCase() === String(src.source).toLowerCase());
}).length;
w(``,
  `  <section>`,
  `    <span class="eyebrow">Subgraph coverage</span>`,
  `    <h2 style="margin: 6px 0 6px">Exact on the credited side, ${observedKpis} of ${allKpis.length} on the observed side</h2>`,
  `    <p class="note" style="margin-bottom: 14px">Folding <span class="mono">Credit</span> reproduced`,
  `    <span class="mono">userCreditedOf</span> on <b>${allKpis.length - graphDrifts} of ${allKpis.length}</b> KPIs and`,
  `    <span class="mono">TierPayout</span> reconciled to escrow on all ${campaigns.length} campaigns — the`,
  `    <span class="mono">Graph</span> columns above are that check, run per referral. The observed side is a`,
  `    different story: a KPI is only observable if a template spawned for its source contract.</p>`,
  `    <div class="scroll"><table>`,
  `      <thead><tr><th>Template spawned</th><th>Address</th><th class="r">At block</th></tr></thead>`,
  `      <tbody>`);
for (const sp of spawned) {
  w(`        <tr><td class="t">${esc(sp.template)}</td><td>${esc(sourceName(sp.address))} <span class="zero">${short(sp.address, 12)}</span></td><td class="r zero">${num(sp.spawnedAtBlock)}</td></tr>`);
}
w(`      </tbody>`, `    </table></div>`);
if (unsupported.length) {
  w(`    <p class="note" style="margin: 14px 0 8px"><b>${unsupported.length} event shapes have no template</b>,`,
    `    so every KPI riding them reads <span class="mono">source: null</span> and spawns nothing. Two separate`,
    `    causes hide here: a signature no template declares, and a 224-byte <span class="mono">params</span> blob`,
    `    the deployed mapping refuses even though <span class="mono">subgraph/src/kpiSource.ts</span> handles it —`,
    `    that half is a redeploy away, not a code change.</p>`,
    `    <div class="scroll"><table>`,
    `      <thead><tr><th>Source</th><th>topic0</th><th class="r">Actor</th><th class="r">Mode</th><th class="r">KPIs waiting</th><th class="r">First seen</th></tr></thead>`,
    `      <tbody>`);
  for (const u of unsupported) {
    w(`        <tr><td class="t">${esc(sourceName(u.source))} <span class="zero">${short(u.source, 12)}</span></td>`,
      `          <td class="zero">${short(u.topic0, 12)}</td><td class="r">${esc(ACTOR[Number(u.actorTopic)] ?? u.actorTopic)}</td>`,
      `          <td class="r">${esc(MODE[Number(u.amountMode)] ?? u.amountMode)}</td>`,
      `          <td class="r">${num(u.kpiCount)}</td><td class="r zero">${num(u.firstSeenAtBlock)}</td></tr>`);
  }
  w(`      </tbody>`, `    </table></div>`);
}
w(`  </section>`);

// ── silences: the conditions that fail without reverting, and which are live ──
type Silence = {title: string; why: string; hits: string[]; tone: string};
const headBlock = BigInt(data.head as unknown as string);
const label = (c: Row, k: Row) => `${c.name} kpi ${k.index}`;
const S: Silence[] = [
  {
    title: "A ceiling exists and no claim was ever filed",
    why: "The relayer observed activity, the project never reported it, and `min(claim, ceiling)` is `min(0, n)`. Nothing reverts; the tier ladder simply never advances.",
    tone: "bad",
    hits: gated.filter(({refs}) => refs.some((r) => (r.ceiling ?? 0n) > 0n) && refs.every((r) => r.claim === 0n))
      .map(({c, k, refs}) => `${label(c, k)} — ${num(refs.reduce((s2, r) => s2 + (r.ceiling ?? 0n), 0n))} units observed, 0 credited`),
  },
  {
    title: "Credited above an independent re-scan",
    why: "The chain credits more than the KPI's own `params` can find in the logs. Crediting is monotonic, so the fix stops the growth and retracts nothing — treat these totals as fiction, not as a baseline.",
    tone: "bad",
    hits: allKpis.filter(({refs}) => refs.some((r) => r.rescan !== null && r.claim > r.rescan))
      .map(({c, k, refs}) => {
        const claim = refs.reduce((s2, r) => s2 + r.claim, 0n);
        const seen = refs.reduce((s2, r) => s2 + (r.rescan ?? 0n), 0n);
        const ratio = seen === 0n ? "∞" : `${(Number(claim) / Number(seen)).toFixed(2)}×`;
        return `${label(c, k)} — ${num(claim)} credited against ${num(seen)} found, ${ratio}`;
      }),
  },
  {
    title: "Credited below an independent re-scan",
    why: "Not necessarily wrong. The relayer excludes activity predating each referral's own `signedAt` and drops work nobody held; a plain re-scan does neither, so it is an upper bound on creditable activity. A gap can be permanent rather than a delay.",
    tone: "warn",
    hits: allKpis.filter(({refs}) => refs.some((r) => r.rescan !== null && r.claim < r.rescan))
      .map(({c, k, refs}) => `${label(c, k)} — ${num(refs.reduce((s2, r) => s2 + r.claim, 0n))} credited, ${num(refs.reduce((s2, r) => s2 + (r.rescan ?? 0n), 0n))} found`),
  },
  {
    title: "Ceiling well above the claim",
    why: "Harmless by direction — an adapter may only discount — but it means the observation double-counted. Additive totals plus two relay passes over one block range write the range in twice.",
    tone: "warn",
    hits: gated.filter(({refs}) => refs.some((r) => r.claim > 0n && (r.ceiling ?? 0n) > (r.claim * 3n) / 2n))
      .map(({c, k, refs}) => {
        const over = refs.filter((r) => r.claim > 0n && (r.ceiling ?? 0n) > (r.claim * 3n) / 2n);
        return `${label(c, k)} — ${over.length} of ${refs.filter((r) => r.claim > 0n).length} referrals, e.g. ${short(over[0]!.user, 10)} ceiling ${num(over[0]!.ceiling)} against claim ${num(over[0]!.claim)}`;
      }),
  },
  {
    title: "A source is declared and nothing has ever matched",
    why: "An OR-filtered re-scan of every referral returns the empty set, not a low count. “Nobody acted” and “the actor topic is wrong” are indistinguishable from outside, and the tier ladder is unreachable either way.",
    tone: "idle",
    hits: allKpis.filter(({k, refs}) => k.source && refs.every((r) => r.claim === 0n && (r.rescan ?? 0n) === 0n && (r.ceiling ?? 0n) === 0n))
      .map(({c, k}) => `${label(c, k)} — ${sourceName((k.source as unknown as Row).source)}, actor ${ACTOR[Number((k.source as unknown as Row).actorTopic)]}`),
  },
  {
    title: "Observation is stale",
    why: "The checkpoint is the relayer's own position. Until it moves, a gated KPI's ceiling cannot rise, and a report landing against a ceiling of 0 succeeds and credits nothing.",
    tone: "warn",
    hits: gated.filter(({k}) => headBlock - (B(k.checkpoint) ?? 0n) > 20000n)
      .map(({c, k}) => `${label(c, k)} — checkpoint ${num(k.checkpoint)}, ${num(headBlock - (B(k.checkpoint) ?? 0n))} blocks behind head`),
  },
  {
    title: "An unfiltered Transfer counts more than a mint",
    why: "With no `filterTopic 1 = 0x0`, any transfer *to* a referral credits, not only a mint from the zero address. The same token passed between referrals credits each of them.",
    tone: "warn",
    hits: allKpis.filter(({k}) => {
      const src = k.source as unknown as Row | null;
      return !!src && String(src.topic0).startsWith("0xddf252ad") && !src.filterTopic;
    }).map(({c, k}) => `${label(c, k)} — ${sourceName((k.source as unknown as Row).source)}, no filter`),
  },
  {
    title: "Credit segmented away from the promoter who holds the referral now",
    why: "Correct behaviour, not a loss: `Campaign` credits whoever held the referral at each action's block. It looks like a zero if you read `creditedToOf` against the live promoter alone.",
    tone: "idle",
    hits: allKpis.filter(({refs}) => refs.some((r) => r.claim > 0n && r.creditedToLive < r.claim))
      .map(({c, k, refs}) => {
        const moved = refs.filter((r) => r.claim > 0n && r.creditedToLive < r.claim);
        return `${label(c, k)} — ${moved.length} referral${moved.length === 1 ? "" : "s"}, e.g. ${short(moved[0]!.user, 10)} credited ${num(moved[0]!.claim)} with ${num(moved[0]!.creditedToLive)} to its live promoter`;
      }),
  },
  {
    title: "A re-scan window was dropped",
    why: "A failed `eth_getLogs` chunk *understates* activity, so it must be surfaced rather than swallowed — an empty result and a lost result look the same in a fold.",
    tone: "bad",
    hits: allKpis.filter(({k}) => (k.rescanFailedWindows as unknown as string[]).length)
      .map(({c, k}) => `${label(c, k)} — ${(k.rescanFailedWindows as unknown as string[]).length} chunks`),
  },
];

const firing = S.filter((x) => x.hits.length);
w(``,
  `  <section>`,
  `    <span class="eyebrow">Silences</span>`,
  `    <h2 style="margin: 6px 0 6px">${firing.length} of ${S.length} conditions that fail without reverting are live</h2>`,
  `    <p class="note" style="margin-bottom: 14px">None of these throws, none appears in a transaction receipt,`,
  `    and none is visible on a campaign page. Each row was computed from the readings above rather than`,
  `    asserted, so the list is empty when the fixture is clean.</p>`,
  `    <div class="layers">`);
for (const x of S) {
  const live = x.hits.length > 0;
  w(`      <div class="layer">`,
    `        <div class="rail"><span class="n">${live ? x.hits.length : "0"}</span><span class="stripe s-${live ? (x.tone === "bad" ? "warn" : x.tone === "warn" ? "warn" : "idle") : "pass"}"></span></div>`,
    `        <div class="lbody">`,
    `          <div class="lhead"><h2>${esc(x.title)}</h2>`,
    `            <span class="badge b-${live ? x.tone : "pass"}">${live ? `${x.hits.length} live` : "not firing"}</span></div>`,
    `          <p>${esc(x.why).replace(/`([^`]+)`/g, "<span class=\"mono\">$1</span>")}</p>`);
  if (live) {
    w(`          <div class="readout">`);
    for (const h of x.hits) w(`            <div class="ro"><span class="v">${esc(h)}</span></div>`);
    w(`          </div>`);
  }
  w(`        </div>`, `      </div>`);
}
w(`    </div>`, `  </section>`);

w(``,
  `  <footer>`,
  `    <span>Read from Base Sepolia at block ${num(data.head)} on ${esc(String(data.collectedAt).slice(0, 10))}. Subgraph ${esc(String((data.subgraph as unknown as Row).url))} at block ${num((data.subgraph as unknown as Row).block)}.</span>`,
  `    <span>Regenerate: <span class="mono">tsx scripts/__dash-collect.mts</span> then <span class="mono">tsx scripts/__dash-build.mts</span>. Every figure on this page comes from the JSON the first writes.</span>`,
  `    <span>The re-scan column replays each KPI's own <span class="mono">params</span> through <span class="mono">eth_getLogs</span> narrowed to that campaign's referrals. It ignores attribution, so it is an upper bound on creditable activity: a claim above it is conclusive over-crediting, a claim below it is not by itself an error.</span>`,
  `  </footer>`,
  `</div>`);

const html = out.join("\n");
writeFileSync(new URL("../public/verification-dashboard.html", import.meta.url), `${html}\n`);
console.log(`wrote web/public/verification-dashboard.html — ${html.split("\n").length} lines, ${allKpis.length} KPIs, ${firing.length} live silences`);
