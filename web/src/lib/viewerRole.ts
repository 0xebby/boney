/**
 * Who is looking at a campaign, and which of its sections that entitles them to.
 *
 * The campaign page serves four different readers off one route, and until now it showed all of them
 * everything: a referred user got the escrow accounting, and the project owner got the promoter-facing
 * reward ladders. Neither is information those readers can act on, and both crowd out what they can.
 *
 * Roles are derived from chain state only — the campaign's `project` address, `promoterIdOf`, and
 * `AttributionRegistry.touchOf` — so nothing here is a permission. It cannot be: every one of those
 * facts is public, and a determined reader can query the contracts directly. This decides what the
 * page *leads with* for each reader, not what they are allowed to know. Any section that carries real
 * authority is gated by the contract instead (`ProjectActions` and `ReportPanel` would revert
 * `NotReporter` for anyone else, whatever this file says).
 *
 * Pure and React-free (decision F6), so the matrix is a table a test can read rather than a chain of
 * `&&` spread across JSX.
 */

export type ViewerRole =
  /** No wallet. Can browse the campaign, but has no position in it. */
  | "disconnected"
  /** Owns the campaign — `CampaignConfig.project`. */
  | "project"
  /** Has joined as a promoter. */
  | "promoter"
  /** Has been attributed to some promoter on this campaign; a referred end user. */
  | "referral"
  /** Connected, with no position in this campaign — a prospective promoter. */
  | "visitor";

export type RoleInput = {
  connected: boolean;
  /** The connected wallet, in any casing. */
  wallet?: string;
  /** `CampaignConfig.project`. */
  project: string;
  /** `promoterIdOf(wallet) != 0`. */
  joined: boolean;
  /** `touchOf(campaign, wallet)` returned a touch, live or expired. */
  referred: boolean;
};

/**
 * The one role a viewer is treated as, most-invested first.
 *
 * A wallet can genuinely hold several of these at once — a project can join its own campaign, and a
 * promoter can be someone else's referral — so an order is required rather than optional. Ownership
 * wins because it is the only role with writes behind it, and promoter beats referral because a
 * promoter has a payout at stake where a referral has none.
 *
 * Expired attributions still count as `referral`. The touch lapsing changes what the *contract* will
 * credit, not who the person is, and flipping them to `visitor` would hand them the promoter's
 * reward-ladder view the moment their attribution went stale.
 */
export function viewerRole(input: RoleInput): ViewerRole {
  if (!input.connected || !input.wallet) return "disconnected";
  if (input.wallet.toLowerCase() === input.project.toLowerCase()) return "project";
  if (input.joined) return "promoter";
  if (input.referred) return "referral";
  return "visitor";
}

/** Whether a wallet owns this campaign. The check `ProjectActions` and `ReportPanel` both make. */
export function isProjectWallet(wallet: string | undefined, project: string): boolean {
  return Boolean(wallet && wallet.toLowerCase() === project.toLowerCase());
}

export type SectionVisibility = {
  /** KPI panels and their reward-tier ladders. */
  kpis: boolean;
  /**
   * The "how to take part" panel — what each KPI asks for, and where to do it.
   *
   * True for every role, and in the table rather than left implicit because this is where a reader
   * looks for "who sees what". It is the one section with no per-role argument against it: a referral
   * needs it to know what counts, a promoter to know what they are sending people to do, a visitor to
   * evaluate the campaign before joining, and the project to read back what it published. Nothing in
   * it is an accounting figure or a payout, which is what every other exclusion below turns on.
   */
  guide: boolean;
  /** The project's table of promoters and what each has been paid. */
  promoterTable: boolean;
  /** Share of escrow released, plus the campaign's window and gate. */
  poolUtilization: boolean;
  /** When unspent escrow returns to the project. */
  escrowReturn: boolean;
  /**
   * The header tiles that quote payouts and remaining escrow.
   *
   * Tied to `poolUtilization` rather than left on for everyone, because "Paid out — of 50K" is the
   * same ratio the utilization meter draws. Hiding the meter and keeping the tile would say the
   * quiet part anyway. The pool size and the closing time stay visible to all: both are already on
   * every marketplace row, and they are what a campaign advertises.
   */
  escrowTiles: boolean;
};

/**
 * Which sections a role sees.
 *
 * Three decisions are load-bearing:
 *
 *  - **The ladders need a wallet.** A tier threshold is only meaningful against "what would *I* be
 *    paid", so the KPI section is where a viewer's own progress appears once they join. Rendering it
 *    to nobody in particular invites the reading that the numbers are a campaign-wide promise.
 *  - **A project owner sees the table instead, not as well.** The ladders are the same numbers the
 *    owner set at creation; what they cannot get anywhere else is who joined and what it has cost.
 *  - **A referral sees neither the ladders nor the escrow.** They are not paid from this pool. A
 *    reward ladder invites them to expect a payout they cannot earn, and the escrow figures describe
 *    an arrangement between the project and its promoters.
 */
export function visibleSections(role: ViewerRole): SectionVisibility {
  switch (role) {
    case "project":
      return {
        kpis: false,
        guide: true,
        promoterTable: true,
        poolUtilization: true,
        escrowReturn: true,
        escrowTiles: true,
      };
    case "promoter":
    case "visitor":
      return {
        kpis: true,
        guide: true,
        promoterTable: false,
        poolUtilization: true,
        escrowReturn: true,
        escrowTiles: true,
      };
    case "referral":
      return {
        kpis: false,
        guide: true,
        promoterTable: false,
        poolUtilization: false,
        escrowReturn: false,
        escrowTiles: false,
      };
    case "disconnected":
      return {
        kpis: false,
        guide: true,
        promoterTable: false,
        poolUtilization: true,
        escrowReturn: true,
        escrowTiles: true,
      };
  }
}
