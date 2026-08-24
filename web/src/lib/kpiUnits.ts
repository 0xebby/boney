import {AMOUNT_MODE, type AmountMode} from "./kpiSource";
import {parseEventSignature} from "./relayCore";
import {formatTokenAmount} from "./format";
import {KPI_KIND_LABEL, type KpiKind} from "./types";

/**
 * What one unit of progress costs, in a sentence.
 *
 * ## The gap this fills
 *
 * A KPI's `scale` is a divisor applied to a referral's *running total* (`indexerCore.foldActions`),
 * and until now the only place the app said so was a five-word fragment on the campaign page —
 * `· 10 per unit` — which never named what ten of the things were. The create form said less: a bare
 * numeric input, and one hint sentence covering only the `dataWord0` case.
 *
 * That gap has already cost a live campaign. Base Sepolia's "lynx (wrap and unwrap ETH)" was created
 * in `count` mode with `scale: 10`; its referral made 51 WETH deposits and was credited 5, because
 * `51 / 10` truncates. Its first tier sits at 50, so that ladder needs 500 wraps — a fact that
 * appeared nowhere before the gas was spent, and nowhere after. `KpiSpec.params` has no setter, so
 * that campaign cannot be corrected. It can only be made legible.
 *
 * ## Why scale means two different things
 *
 * The divisor is the same operation in both modes, but what it divides is not:
 *
 *  - **`dataWord0`** reads the log's first data word — a token amount in base units. Scale is a unit
 *    conversion, and the useful one: `1e15` turns wei into thousandths of an ETH so tier thresholds
 *    can be small integers.
 *  - **`count`** ignores the payload and yields exactly 1 per log (`indexerCore.rawAmount`). There is
 *    no magnitude left to convert, so a scale above 1 can only make thresholds harder to reach. It is
 *    expressible — "ten deposits per unit" is a real thing to want — but it is almost never what
 *    someone typing a number into a box labelled "Scale" meant.
 *
 * Naming that difference out loud is this module's whole job.
 *
 * Pure and React-free (decision F6), like `kpiSource.ts` and `eventNames.ts`: the wording rules are
 * the part that can be wrong, and `vitest.config.mts` runs a `node` environment over `src/**\/*.test.ts`,
 * so a fixture can pin every sentence below without a DOM or a chain.
 */

// ── shape ────────────────────────────────────────────────────────

/** Everything a sentence depends on. Mirrors a decoded `EventSource` plus what named it. */
export type UnitInput = {
  amountMode: AmountMode;
  /** The raw `EventSource.scale`. Zero is treated as one, per `kpiSource.effectiveScale`. */
  scale: bigint;
  /** The event signature, when anything resolved one — `Deposit(address,uint256)`. */
  signature?: string;
  /** Category hint from the spec, the fallback when no signature parsed. */
  kind: KpiKind;
  /** The watched contract's own metadata, when it answers `symbol()`/`decimals()`. */
  token?: {symbol?: string; decimals?: number};
};

/** A countable noun for one matched log, singular and plural. */
export type ActionNoun = {one: string; many: string};

/**
 * The generic fallback.
 *
 * Used whenever nothing better is honest — no signature, an unparseable one, or a `kind` whose label
 * is a mass noun. "3 events" is vague; "3 volume generateds" is wrong, and wrong reads as a bug in
 * the page rather than as a gap in what the chain published.
 */
const GENERIC: ActionNoun = {one: "event", many: "events"};

/**
 * `kind` labels that cannot be counted.
 *
 * `KPI_KIND_LABEL` exists to head a column, not to be pluralized mid-sentence. Most of its entries
 * happen to work ("Deposits" → "deposit"), but these describe a quantity or a category rather than an
 * occurrence, and there is no singular of "TVL generated" that belongs in "10 ___ = 1 unit".
 */
const MASS_KINDS: ReadonlySet<KpiKind> = new Set<KpiKind>([
  "Custom",
  "Tvl",
  "Volume",
  "Stake",
  "ActiveUser",
]);

// ── the action noun ──────────────────────────────────────────────

/**
 * What to call one matching log.
 *
 * Prefers the event's own name, because it is the only source that describes *this* KPI rather than
 * its category: two `Deposit` KPIs and a `Withdrawal` one all carry `kind: Deposit` on the lynx
 * campaign, and a sentence built from the kind would call the withdrawal a deposit.
 *
 * `parseEventSignature` is reused rather than a regex, so this agrees with the relayer about what a
 * signature is. It throws by design (see its docstring); here the string arrives from a contract's
 * storage while a page renders, so a failure degrades to the next source rather than blanking a card.
 */
export function actionNoun(signature: string | undefined, kind: KpiKind): ActionNoun {
  const fromSignature = nounFromSignature(signature);
  if (fromSignature) return fromSignature;

  if (MASS_KINDS.has(kind)) return GENERIC;

  const label = KPI_KIND_LABEL[kind];
  if (!label) return GENERIC;

  // Labels are plural by convention ("Deposits", "NFT mints"), which is the form a threshold
  // sentence needs; the singular is only used for a scale of one.
  const many = label.toLowerCase();
  return {one: singularize(many), many};
}

function nounFromSignature(signature: string | undefined): ActionNoun | undefined {
  const trimmed = signature?.trim();
  if (!trimmed) return undefined;

  let name: string;
  try {
    name = parseEventSignature(trimmed).event.name;
  } catch {
    return undefined;
  }

  if (!name) return undefined;

  /*
    Two shapes, because most event names are nouns and the rest are not.

    `Deposit` and `Withdrawal` are things you can have ten of, so they read best lowercased and
    pluralized: "10 deposits". `Deposited`, `Minted` and `SupplyExecuted` are not — "10 depositeds" is
    the kind of wrong that reads as a bug in the page. Those keep their real name and borrow a noun:
    "10 Deposited events", which is never elegant and never wrong.
  */
  if (SIMPLE_NOUN_RE.test(name) && !name.endsWith("ed")) {
    const word = name.toLowerCase();
    return {one: word, many: pluralize(word)};
  }

  return {one: `${name} event`, many: `${name} events`};
}

/**
 * An event name that is already a countable noun.
 *
 * One capitalised word — `Deposit`, `Swap`, `Transfer`, `Withdrawal`. Callers pair this with an `-ed`
 * check, which is what keeps `Deposited` out; a compound like `SupplyExecuted` fails the single-word
 * test first.
 */
const SIMPLE_NOUN_RE = /^[A-Z][a-z]+$/;

/**
 * English plurals, to the depth this actually needs.
 *
 * Every noun reaching here is an event name or a `KPI_KIND_LABEL` entry, so the input space is
 * "deposit", "withdrawal", "swap", "transfer", "mint". The `-s`/`-es`/`-y` rules cover all of them.
 * Not a general pluralizer, and deliberately not a dependency: an irregular noun would be a wrong
 * word in a sentence, which the generic fallback already exists to avoid.
 */
function pluralize(word: string): string {
  if (word.endsWith("s") || word.endsWith("x") || word.endsWith("ch") || word.endsWith("sh")) {
    return `${word}es`;
  }
  if (word.endsWith("y") && !/[aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("xes")) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// ── the unit sentence ────────────────────────────────────────────

/**
 * One sentence naming what a single unit of progress costs.
 *
 * Written as an equation rather than as prose about scaling, because the reader's question is
 * arithmetic — "how many of my actions is one of these" — and every version of this that explained
 * the mechanism instead ended up longer and less answerable.
 *
 * The `dataWord0` branch degrades in two steps. With the contract's own `decimals()` it can name a
 * real amount ("0.001 WETH"); without, it says the divisor and what it would mean at 18 decimals,
 * hedged, because guessing the decimals of a contract that would not answer is how a page states a
 * token figure that is off by orders of magnitude.
 */
export function describeUnit(input: UnitInput): string {
  const scale = input.scale === BigInt(0) ? BigInt(1) : input.scale;

  if (input.amountMode === AMOUNT_MODE.count) {
    const noun = actionNoun(input.signature, input.kind);
    if (scale === BigInt(1)) return `Each ${noun.one} counts as 1 unit of progress.`;
    return `${scale.toLocaleString("en-US")} ${noun.many} = 1 unit of progress.`;
  }

  const decimals = input.token?.decimals;
  const symbol = input.token?.symbol;

  if (decimals !== undefined && decimals >= 0) {
    const amount = formatTokenAmount(scale, decimals, {maxFractionDigits: 18});
    const unit = symbol ? `${amount} ${symbol}` : `${amount} tokens`;
    return `${unit} = 1 unit of progress.`;
  }

  if (scale === BigInt(1)) {
    return "1 base unit = 1 unit of progress — thresholds will be very large for an 18-decimal token.";
  }

  const atEighteen = formatTokenAmount(scale, 18, {maxFractionDigits: 18});
  return (
    `${scale.toLocaleString("en-US")} base units = 1 unit of progress — ` +
    `${atEighteen} of an 18-decimal token.`
  );
}

// ── thresholds in real actions ───────────────────────────────────

/**
 * A tier threshold restated as the work it actually takes.
 *
 * The highest-value sentence here, and the one that would have caught the lynx campaign: a project
 * types `50` into a field labelled "Tier 1 threshold" having read nothing about scale, and this says
 * `= 500 deposits` directly underneath.
 *
 * Only answerable in `count` mode. Under `dataWord0` a threshold is a token amount, not a number of
 * actions — one swap could cross the whole ladder — so there is no action count to give and this
 * returns `null` rather than inventing one. `describeUnit` already carries the honest answer there.
 *
 * Returns `null` for an unscaled count KPI too: "50 units = 50 deposits" restates the number it sits
 * under, and a line that says nothing still costs the reader an eye movement.
 */
export function describeThreshold(threshold: bigint, input: UnitInput): string | null {
  if (input.amountMode !== AMOUNT_MODE.count) return null;
  if (threshold <= BigInt(0)) return null;

  const scale = input.scale === BigInt(0) ? BigInt(1) : input.scale;
  if (scale === BigInt(1)) return null;

  const actions = threshold * scale;
  const noun = actionNoun(input.signature, input.kind);
  const word = actions === BigInt(1) ? noun.one : noun.many;

  return `${actions.toLocaleString("en-US")} ${word}`;
}
