import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {getStore} from "@netlify/blobs";
import {sanitizeGuide, isEmptyGuide, type CampaignGuide} from "./campaignGuide";

/**
 * The writable half of a campaign guide — keyed by chain and campaign address.
 *
 * Server-only: it touches `node:fs`, so importing it from a client component would fail the build.
 * `/api/campaign-guide` is the only caller.
 *
 * ## Two backends, one shape
 *
 * `lib/campaignGuide.CATALOG` is committed and covers the campaigns already on chain. It cannot cover
 * a campaign someone creates through the form, and there is nowhere on chain to put the guide
 * (`Types.CampaignConfig` has no slot), so a guide written by a project has to live off-chain.
 *
 * On Netlify that is **Netlify Blobs**: the function filesystem is ephemeral and read-only outside
 * `/tmp`, so a file write there fails and every guide published from the deployed UI would be lost.
 * Locally it is a JSON file under `.data/`, because plain `next dev` has no Blobs credentials injected
 * — reaching a real store from a dev loop would mean a personal access token and writes against
 * production data.
 *
 * Both hold the same `Store` object under one key, so the local file can be pasted into the blob (or
 * the reverse) with no transformation.
 *
 * Reads never throw. A missing store and an unusable one both mean "nothing stored", which lets the
 * catalog respond — a campaign page failing because a convenience store was absent would be a worse
 * trade than a page that shows one section fewer.
 *
 * A read that *failed* is held apart from a store that is empty, because `writeGuide` merges into what
 * it read. Treating an outage as `{}` would persist a store holding only the guide being written, drop
 * every other one, and report success doing it.
 *
 * ## Consistency
 *
 * The blob store is read with `consistency: "strong"`. Blobs default to eventual consistency, which
 * propagates within about a minute; the editor refetches the guide the moment a publish returns, so an
 * eventually-consistent read would hand a project back the guide it had just replaced and look exactly
 * like the write having failed.
 *
 * ## Concurrency
 *
 * Read-modify-write with no lock, which is sound for what this is: one project's browser writing one
 * guide once, right after its own `createCampaign` landed. Two simultaneous writers could lose one
 * guide, and the loser's own POST would report success. Not worth a compare-and-swap for this — but
 * worth knowing before this is reached for as general storage.
 */

/** `{[chainId]: {[campaignAddressLower]: CampaignGuide}}`. */
type Store = Record<string, Record<string, CampaignGuide>>;

/** The Netlify Blobs store, and the single key inside it holding the whole `Store`. */
const BLOB_STORE = "campaign-guides";
const BLOB_KEY = "guides";

/**
 * Whether to persist through Netlify Blobs rather than the filesystem.
 *
 * `NETLIFY` is set in their build and function runtimes and nowhere else. An explicit
 * `BONEY_GUIDE_STORE` wins over it, so a test names a temp file and gets a temp file.
 */
function blobsBacked(): boolean {
  return Boolean(process.env.NETLIFY) && !process.env.BONEY_GUIDE_STORE;
}

/**
 * Where the file-backed store lives.
 *
 * `.data/` beside the Next app rather than under `public/` — `public/` is served verbatim, which would
 * publish the file at a guessable URL and make every write a deploy-visible artifact. Overridable
 * with `BONEY_GUIDE_STORE` so a test or a container can point it somewhere writable.
 */
function storePath(): string {
  return process.env.BONEY_GUIDE_STORE ?? join(process.cwd(), ".data", "campaign-guides.json");
}

/**
 * Opens the blob store.
 *
 * Lazily, not at module scope: `getStore` reads the site and token out of the environment, which only
 * exists inside a Netlify function, and importing this module must stay inert everywhere else.
 *
 * @returns The strongly-consistent `campaign-guides` store.
 */
function blobStore(): ReturnType<typeof getStore> {
  return getStore({name: BLOB_STORE, consistency: "strong"});
}

/**
 * A read attempt: the store, or the fact that it could not be read.
 *
 * Absent and unreadable are different answers. Absent is the ordinary first-run state and a write
 * proceeds from `{}`; unreadable is a state a write must not merge into.
 */
type ReadResult = {ok: true; store: Store} | {ok: false};

/** Whether a filesystem error means the store has simply never been written. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Reads the whole store from whichever backend this deployment uses.
 *
 * Never throws. A store that has never been written reads as an empty one; anything else that goes
 * wrong — an outage, a truncated file, a JSON value that is not an object — reports failure, so the
 * write path can refuse rather than overwrite what it could not read.
 *
 * @returns The parsed store, an empty one when it is absent, or a failure.
 */
async function readStore(): Promise<ReadResult> {
  let parsed: unknown;

  try {
    if (blobsBacked()) {
      // Netlify Blobs answers `null` for a key that was never set, and throws for everything else.
      const blob = await blobStore().get(BLOB_KEY, {type: "json"});
      if (blob === null) return {ok: true, store: {}};
      parsed = blob;
    } else {
      parsed = JSON.parse(readFileSync(storePath(), "utf8"));
    }
  } catch (error) {
    return isMissing(error) ? {ok: true, store: {}} : {ok: false};
  }

  // A hand-edited file and a hand-written blob can both hold anything. Something that parsed but is
  // not a store is reported as unreadable rather than silently replaced by the next write.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {ok: false};

  return {ok: true, store: parsed as Store};
}

/**
 * The stored guide for one campaign, or `null`.
 *
 * Sanitized here as well as at write time and again in `resolveCampaignGuide`. The file is editable by
 * hand and `BONEY_GUIDE_STORE` can point at anything, so "it went through the route once" is not a
 * property the read path can rely on.
 *
 * @param chainId Chain the campaign is deployed on.
 * @param campaign Campaign address, in any case.
 * @returns The sanitized guide, or `null` when nothing usable is stored.
 */
export async function readGuide(chainId: number, campaign: string): Promise<CampaignGuide | null> {
  const read = await readStore();
  if (!read.ok) return null;

  const stored = read.store[String(chainId)]?.[campaign.toLowerCase()];
  if (!stored) return null;

  const guide = sanitizeGuide(stored);
  return isEmptyGuide(guide) ? null : guide;
}

/**
 * Persists a guide, returning whether the backend accepted it.
 *
 * `false` rather than a throw, because "this deployment cannot store guides" is an expected state the
 * route reports to the project along with the JSON to commit — not an error to surface as a 500. With
 * Blobs in place that is no longer Netlify's steady state, but it still covers a read-only host, a
 * missing store and a blob write that is rejected.
 *
 * A store that could not be read is refused rather than merged into. This writes back the whole store,
 * so proceeding from a failed read would drop every guide it did not see.
 *
 * An empty guide is stored as a deletion. Otherwise a project that cleared every field would leave the
 * old copy in place with no way to withdraw it, which for a set of outbound links is the wrong default.
 *
 * @param chainId Chain the campaign is deployed on.
 * @param campaign Campaign address, in any case.
 * @param guide The guide to store; an empty one deletes the entry.
 * @returns Whether the write landed.
 */
export async function writeGuide(
  chainId: number,
  campaign: string,
  guide: CampaignGuide,
): Promise<boolean> {
  const clean = sanitizeGuide(guide);
  const read = await readStore();
  if (!read.ok) return false;

  const store = read.store;
  const key = String(chainId);
  const address = campaign.toLowerCase();

  const forChain = {...(store[key] ?? {})};
  if (isEmptyGuide(clean)) delete forChain[address];
  else forChain[address] = clean;

  const next: Store = {...store, [key]: forChain};

  try {
    if (blobsBacked()) {
      await blobStore().setJSON(BLOB_KEY, next);
      return true;
    }

    const path = storePath();
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
