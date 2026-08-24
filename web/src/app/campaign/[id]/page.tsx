import {CampaignDetailPage} from "@/components/CampaignDetailPage";

/**
 * `params` is a Promise in Next 16 and must be awaited — see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`.
 */
export default async function Page({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;

  return <CampaignDetailPage campaignId={parseCampaignId(id)} />;
}

/**
 * Route segments are arbitrary strings. `BigInt("1e5")` throws and `BigInt("-1")` is a valid
 * BigInt but never a valid id, so both are rejected here rather than reaching a contract read.
 */
function parseCampaignId(raw: string): bigint | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}
