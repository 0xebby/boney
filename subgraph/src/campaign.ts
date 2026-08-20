import {
  ProgressCredited,
  PromoterJoined,
  StatusChanged,
  TierSettled,
} from "../generated/templates/CampaignEvents/Campaign";
import {Campaign, Credit, Promoter, TierPayout} from "../generated/schema";

/**
 * Per-campaign events, from a template spawned at campaign creation.
 *
 * `PromoterJoined` is the one that removes a hard limitation rather than just a slow query: nothing on
 * chain enumerates a campaign's promoters, which is why `web/src/hooks/useCampaignPromoters.ts` has to
 * scan logs at all. Indexed, the promoter list is just a field on the campaign.
 */

export function handlePromoterJoined(event: PromoterJoined): void {
  const campaignId = event.address.toHexString();
  const id = campaignId + "-" + event.params.promoterId.toHexString();

  // `PromoterRegistered` on the attribution registry may have created this row already; it carries the
  // id but not the wallet, which only this event has.
  let promoter = Promoter.load(id);
  if (promoter == null) {
    promoter = new Promoter(id);
    promoter.campaign = campaignId;
    promoter.promoterId = event.params.promoterId;
  }

  promoter.wallet = event.params.promoter;
  promoter.reputation = event.params.reputation;
  promoter.joinedAtBlock = event.block.number;
  promoter.save();
}

/**
 * Progress the campaign actually credited.
 *
 * Lets a consumer tell "already credited" from "not yet reported" without one `userCreditedOf` read
 * per referral. That distinction is the difference between a report that credits something and one the
 * contract returns early on, so it is what makes a report button idempotent.
 */
export function handleProgressCredited(event: ProgressCredited): void {
  const id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();

  const credit = new Credit(id);
  credit.campaign = event.address.toHexString();
  credit.kpiIndex = event.params.kpiIndex.toI32();
  credit.promoterId = event.params.promoterId;
  credit.user = event.params.user;
  credit.amount = event.params.amount;
  credit.blockNumber = event.block.number;
  credit.timestamp = event.block.timestamp;
  credit.save();
}

export function handleTierSettled(event: TierSettled): void {
  const id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();

  const payout = new TierPayout(id);
  payout.campaign = event.address.toHexString();
  payout.promoterId = event.params.promoterId;
  payout.promoter = event.params.promoter;
  payout.kpiIndex = event.params.kpiIndex.toI32();
  payout.tier = event.params.tier.toI32();
  // `paid`, not the tier's configured reward: the campaign pays what the pool can cover rather than
  // reverting, so this is less than the reward when the pool ran short (`PoolExhausted`).
  payout.paid = event.params.paid;
  payout.blockNumber = event.block.number;
  payout.timestamp = event.block.timestamp;
  payout.save();
}

/**
 * Tracks campaign status.
 *
 * Reporting closes at `endedAt + CLAIM_GRACE` and `Ended` is set by a permissionless `end()`, so a
 * consumer deciding whether a report can still land needs the current status — not just `endTime`.
 */
export function handleStatusChanged(event: StatusChanged): void {
  const campaign = Campaign.load(event.address.toHexString());
  if (campaign == null) return;

  campaign.status = event.params.current;
  campaign.save();
}
