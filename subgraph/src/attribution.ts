import {TouchStored, PromoterRegistered} from "../generated/AttributionRegistry/AttributionRegistry";
import {Promoter, Touch} from "../generated/schema";

/**
 * Attribution — who a user's activity is creditable to, and from when.
 *
 * This is what replaces the browser's touch log scan (`web/src/hooks/useCampaignTouches.ts`), which
 * could only cover the most recent 24 windows of ~1900 blocks and had to warn the user that a touch
 * signed before that was invisible. Indexed from the registry's deployment block, there is no such
 * horizon.
 */

/**
 * Stores the live touch for a `(campaign, user)` pair.
 *
 * One row per pair, keyed the way the contract keys its own storage, and overwritten only by a
 * strictly newer `signedAt` — the same comparison `AttributionRegistry` makes before accepting a
 * touch. Two reasons this matters rather than just appending every log:
 *
 *  - A user who re-signs under a different promoter appears in the log history under both, but only
 *    the newest is live on chain. Keeping both would present two live attributions for one user, and a
 *    consumer picking the wrong one credits a promoter who no longer holds the user.
 *  - `signedAt` is the floor the pre-attribution filter compares against. After a promoter switch the
 *    floor moves *forward*, which is what deliberately discards pre-switch activity — the behaviour
 *    `TouchWindowVerifier` enforces on chain and `GuardedKpiVerifier`'s CAP mode exists for.
 *
 * Ordering on `signedAt` rather than block number is what makes this match the contract: a touch
 * mined later can carry an older signature, and the contract rejects it.
 */
export function handleTouchStored(event: TouchStored): void {
  const campaignId = event.params.campaign.toHexString();
  const id = campaignId + "-" + event.params.user.toHexString();

  const signedAt = event.params.signedAt;

  const existing = Touch.load(id);
  if (existing != null && existing.signedAt.ge(signedAt)) return;

  const touch = existing == null ? new Touch(id) : existing;
  touch.campaign = campaignId;
  touch.user = event.params.user;
  touch.promoterId = event.params.promoterId;
  touch.signedAt = signedAt;
  touch.expiresAt = event.params.expiresAt;
  touch.relayer = event.params.relayer;
  touch.blockNumber = event.block.number;
  touch.save();
}

/**
 * Records a promoter id issued by a campaign.
 *
 * The wallet behind the id is not in this event — `PromoterJoined` on the campaign carries it — so
 * this creates the row and `handlePromoterJoined` fills in the wallet. Either can land first as far as
 * this subgraph is concerned, so both upsert rather than assuming.
 */
export function handlePromoterRegistered(event: PromoterRegistered): void {
  const campaignId = event.params.campaign.toHexString();
  const id = campaignId + "-" + event.params.promoterId.toHexString();

  if (Promoter.load(id) != null) return;

  const promoter = new Promoter(id);
  promoter.campaign = campaignId;
  promoter.promoterId = event.params.promoterId;
  promoter.save();
}
