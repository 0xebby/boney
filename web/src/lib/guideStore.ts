import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {sanitizeGuide, isEmptyGuide, type CampaignGuide} from "./campaignGuide";

/**
 * The writable half of a campaign guide — a JSON file on disk, keyed by chain and campaign address.
 *
 * Server-only: it touches `node:fs`, so importing it from a client component would fail the build.
 * `/api/campaign-guide` is the only caller.
 *
 * ## Why a file, and what that costs
 *
 * `lib/campaignGuide.CATALOG` is committed and covers the five campaigns already on chain, which is
 * the path a deploy relies on. It cannot cover a campaign someone creates through the form, and there
 * is nowhere on chain to put the guide (`Types.CampaignConfig` has no slot). A file is what closes
 * that gap with no new infrastructure.
 *
 * The cost is stated rather than hidden: **this does not persist on Netlify.** Their function
 * filesystem is ephemeral and read-only outside `/tmp`, so a write there fails and
 * `/api/campaign-guide` answers `501` with the JSON to paste into the catalog. Locally — which is
 * where the fixture is driven, via `pnpm dev:up` — it works, and a guide is live the moment the
 * campaign is created.
 *
 * Reads never throw. A missing file is the ordinary first-run state, and an unreadable one on a
 * read-only deploy is the ordinary steady state; in both cases the answer is "nothing stored", which
 * lets the catalog respond. A campaign page failing because a convenience file was absent would be a
 * worse trade than a page that shows one section fewer.
 *
 * ## Concurrency
 *
 * Read-modify-write with no lock, which is sound for what this is: one project's browser writing one
 * guide once, right after its own `createCampaign` landed. Two simultaneous writers could lose one
 * guide, and the loser's own POST would report success. Not worth a lockfile for a dev convenience —
 * but worth knowing before this is reached for as general storage.
 */

/** `{[chainId]: {[campaignAddressLower]: CampaignGuide}}`. */
type Store = Record<string, Record<string, CampaignGuide>>;

/**
 * Where the store lives.
 *
 * `.data/` beside the Next app rather than under `public/` — `public/` is served verbatim, which would
 * publish the file at a guessable URL and make every write a deploy-visible artifact. Overridable
 * with `BONEY_GUIDE_STORE` so a test or a container can point it somewhere writable.
 */
function storePath(): string {
  return process.env.BONEY_GUIDE_STORE ?? join(process.cwd(), ".data", "campaign-guides.json");
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
    // A hand-edited file can hold anything; anything that is not an object is treated as empty
    // rather than crashing every campaign page until someone notices.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/**
 * The stored guide for one campaign, or `null`.
 *
 * Sanitized here as well as at write time and again in `resolveCampaignGuide`. The file is editable by
 * hand and `BONEY_GUIDE_STORE` can point at anything, so "it went through the route once" is not a
 * property the read path can rely on.
 */
export function readGuide(chainId: number, campaign: string): CampaignGuide | null {
  const stored = readStore()[String(chainId)]?.[campaign.toLowerCase()];
  if (!stored) return null;

  const guide = sanitizeGuide(stored);
  return isEmptyGuide(guide) ? null : guide;
}

/**
 * Persists a guide, returning whether the filesystem accepted it.
 *
 * `false` rather than a throw, because "this deployment cannot store guides" is an expected state the
 * route reports to the project along with the JSON to commit — not an error to surface as a 500.
 *
 * An empty guide is stored as a deletion. Otherwise a project that cleared every field would leave the
 * old copy in place with no way to withdraw it, which for a set of outbound links is the wrong default.
 */
export function writeGuide(chainId: number, campaign: string, guide: CampaignGuide): boolean {
  const clean = sanitizeGuide(guide);
  const store = readStore();
  const key = String(chainId);
  const address = campaign.toLowerCase();

  const forChain = {...(store[key] ?? {})};
  if (isEmptyGuide(clean)) delete forChain[address];
  else forChain[address] = clean;

  const next: Store = {...store, [key]: forChain};

  try {
    const path = storePath();
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
