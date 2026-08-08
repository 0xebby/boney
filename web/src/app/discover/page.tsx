"use client";

import {useCampaigns} from "@/hooks/useCampaigns";
import {DiscoverPage} from "@/components/DiscoverPage";
import {Card} from "@/components/ui/Card";
import {EmptyState} from "@/components/ui/States";

/**
 * `/discover` — browse promoters by BoneyScore rank.
 *
 * A client component because the campaign list and the promoter scan both come from the connected
 * chain. No wallet is required: this is a browsing surface, and a project evaluating the
 * marketplace should not have to connect before it can see who is here.
 */
export default function Page() {
  const {campaigns, isLoading, error, refetch, deployed} = useCampaigns();

  if (!deployed) {
    return (
      <Card>
        <EmptyState
          title="Boneyard is not available on this network"
          description="Switch your wallet to a supported network to browse promoters."
        />
      </Card>
    );
  }

  return (
    <DiscoverPage
      campaigns={campaigns}
      isLoading={isLoading}
      error={error}
      onRetry={() => refetch()}
    />
  );
}
