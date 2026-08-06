import type {CampaignStatus} from "@/lib/types";

/**
 * StatusPill — campaign lifecycle state.
 *
 * Status colors are reserved tokens (never reused as series colors) and always ship with a
 * text label, so state is never carried by color alone.
 */
const STATUS_STYLE: Record<CampaignStatus, {dot: string; text: string}> = {
  Active: {dot: "bg-good", text: "text-good"},
  Pending: {dot: "bg-warning", text: "text-warning"},
  Paused: {dot: "bg-serious", text: "text-serious"},
  Ended: {dot: "bg-ink-muted", text: "text-ink-secondary"},
  Cancelled: {dot: "bg-critical", text: "text-critical"},
};

export function StatusPill({status}: {status: CampaignStatus}) {
  const style = STATUS_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`size-1.5 rounded-full ${style.dot}`} />
      <span className={`text-xs font-medium ${style.text}`}>{status}</span>
    </span>
  );
}
