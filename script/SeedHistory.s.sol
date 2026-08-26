// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {CampaignRegistry} from "../src/campaign/CampaignRegistry.sol";
import {EscrowVault} from "../src/escrow/EscrowVault.sol";
import {AttributionRegistry} from "../src/attribution/AttributionRegistry.sol";
import {IAttributionRegistry} from "../src/interfaces/IAttributionRegistry.sol";
import {Types} from "../src/libraries/Types.sol";

/// @title SeedHistory
/// @notice Promoter *history* for the BoneyCard: two projects, five campaigns, three promoters, and
///         deliberately uneven outcomes.
/// @dev **Append-only, unlike every other seed here.** `SeedFive` and `SeedDemo` assert
///      `campaignCount() == 0` because they define a whole fixture. This one adds to whatever is
///      already on the registry, because its subject is what a *wallet* accumulates across campaigns
///      and the nine that exist are part of that history. It therefore asserts on names instead:
///      every name below must be free, and a second run fails on the first one rather than
///      half-seeding a duplicate set.
///
///      ## Why this exists
///
///      `boneyCardPlan.md` calls it the stage-2 blocker. The card's history half counts campaigns,
///      projects, referrals, tiers and protocol types, and the live deployment could not exercise it:
///      one project address is behind all nine campaigns, so "projects worked with" is 1 for every
///      wallet and "first repeat project" is unreachable. That is why distinct projects is a milestone
///      and not a bone-level rung — a rung nobody can reach is a locked door. Two projects here.
///
///      ## Progress is reported, not observed
///
///      Every KPI below has `verifier == address(0)` and empty `params`. Both are deliberate:
///
///       - **No verifier** means `reportUserAction` credits exactly what is reported, so each
///         promoter's totals are chosen rather than discovered. A fixture whose numbers depend on
///         third-party contract activity is not a fixture.
///       - **Empty params** means `kpiSource` reads these as not event-sourced, so the running relay
///         and indexer ignore them. Without that, the loop would keep reporting its own view of
///         these KPIs and overwrite the shapes below.
///
///      Settlement needs no call: `_settle` runs inline at the end of `reportUserAction`, so tiers pay
///      as thresholds are crossed and `PoolExhausted` fires on the tier that outruns escrow.
///
///      ## The five campaigns, and what each one is for
///
///      | Campaign | Project | Shape it produces on a card |
///      |---|---|---|
///      | `sh alpha` | A | Over-delivery across two protocol types; a second promoter who crosses one rung |
///      | `sh dryrun` | A | A pool too small for its ladder — partial payout, then tiers paying zero |
///      | `sh cutshort` | A | Joined, then ended by the project hours later. No chance to deliver |
///      | `sh bravo` | B | A *second project*, plus an aggregate KPI no promoter can ever score on |
///      | `sh telemetry` | B | Joined and never delivered |
///
///      ## Wallets
///
///      Project A is `PRIVATE_KEY`, already the project behind the live nine. Promoter 1 is `ETHOS_PK`,
///      the dev wallet whose card is the one under development. Everything else — project B, promoters
///      2 and 3, and every referred user — is derived from a fixed namespace string, so addresses are
///      stable across runs and reruns re-derive rather than scatter.
///
///      `REFERRAL_PRIVATE_KEY` is deliberately *not* reused as project B. It has gas and would have
///      saved a funding transfer, but that key already means something in this repo and has been
///      misread as another role once before.
///
///      Derived accounts are funded from A: gas for the two promoters and project B, and bUSD for
///      project B's escrow. The dev wallet gets a gas top-up too — it was down to 0.0089 ETH, which is
///      thin for four joins plus the attestations the card's own verify button submits.
contract SeedHistory is Script {
    /// @dev 30 days, matching the deployed `AttributionRegistry.maxTouchDuration`. `storeTouch` caps a
    ///      touch at `min(attributionWindow, maxTouchDuration)`, so a longer window would buy nothing
    ///      and a longer touch would revert `TouchTooLong`.
    uint64 public constant DURATION = 30 days;

    /// @dev How long each seeded touch claims. Under `DURATION` rather than equal to it: `expiresAt` is
    ///      checked against `block.timestamp` at relay time, and equality leaves no room for the drift
    ///      between simulation and the block the transaction actually lands in.
    uint64 public constant TOUCH_LIFETIME = 29 days;

    /// @dev Gas for each derived account. Base Sepolia is cheap; this is a few hundred transactions'
    ///      worth and it means a rerun never has to re-fund.
    uint256 public constant GAS_FUNDING = 0.02 ether;

    /// @dev Top-up for the dev wallet, which pays for joins here and attestations in the app.
    uint256 public constant DEV_TOP_UP = 0.03 ether;

    uint256 projectAPk;
    uint256 projectBPk;
    uint256 promoter1Pk;
    uint256 promoter2Pk;
    uint256 promoter3Pk;

    address projectA;
    address projectB;
    address promoter1;
    address promoter2;
    address promoter3;

    CampaignRegistry registry;
    EscrowVault vault;
    AttributionRegistry attribution;
    IERC20 token;

    /// @dev Decimals of the reward token, read rather than assumed — Base Sepolia carries two mock bUSD
    ///      deployments and a hardcoded 18 would misprice one of them by a factor of a trillion.
    uint256 unit;

    function run() external {
        projectAPk = vm.envUint("PRIVATE_KEY");
        promoter1Pk = vm.envUint("ETHOS_PK");
        projectBPk = _derive("boney.seedhistory.project.b");
        promoter2Pk = _derive("boney.seedhistory.promoter.grinder");
        promoter3Pk = _derive("boney.seedhistory.promoter.lapsed");

        projectA = vm.addr(projectAPk);
        projectB = vm.addr(projectBPk);
        promoter1 = vm.addr(promoter1Pk);
        promoter2 = vm.addr(promoter2Pk);
        promoter3 = vm.addr(promoter3Pk);

        registry = CampaignRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        vault = EscrowVault(vm.envAddress("VAULT_ADDRESS"));
        attribution = AttributionRegistry(vm.envAddress("ATTRIBUTION_ADDRESS"));
        token = IERC20(vm.envAddress("TOKEN_ADDRESS"));
        unit = 10 ** IERC20Decimals(address(token)).decimals();

        console.log("project A   ", projectA);
        console.log("project B   ", projectB);
        console.log("promoter 1  ", promoter1, "(dev wallet)");
        console.log("promoter 2  ", promoter2);
        console.log("promoter 3  ", promoter3);

        _requireNamesFree();
        _fund();

        address alpha = _alpha();
        address dryrun = _dryrun();
        address cutshort = _cutshort();
        address bravo = _bravo();
        address telemetry = _telemetry();

        console.log("");
        console.log("== what this produced ==");
        _summary(alpha, "sh alpha", 2);
        _summary(dryrun, "sh dryrun", 1);
        _summary(cutshort, "sh cutshort", 1);
        _summary(bravo, "sh bravo", 2);
        _summary(telemetry, "sh telemetry", 1);

        console.log("");
        console.log("Seeded. The subgraph needs a moment to index; the card reads it after that.");
    }

    /// @dev Read the outcomes back and print them.
    ///
    ///      This is the only verification this script can have. `forge script` without `--broadcast`
    ///      executes every call against real chain state, so these reads describe what a broadcast would
    ///      actually produce — a ladder that does not pay, or a pool that exhausts one rung earlier than
    ///      intended, shows up here rather than on a card after the fact.
    function _summary(address campaign, string memory label, uint256 kpiCount) internal view {
        console.log("");
        console.log(label);
        console.log("  status         ", uint256(Campaign(campaign).status()));
        console.log("  pool remaining ", Campaign(campaign).remainingPool() / unit);

        for (uint256 k = 0; k < kpiCount; k++) {
            if (Campaign(campaign).kpi(k).aggregate) {
                console.log("  kpi", k, "aggregate - never creditable");
                continue;
            }
            _promoterLine(campaign, k, promoter1, "  p1");
            _promoterLine(campaign, k, promoter2, "  p2");
            _promoterLine(campaign, k, promoter3, "  p3");
        }
    }

    /// @dev One promoter's line on one KPI, skipped entirely when they never joined.
    function _promoterLine(address campaign, uint256 kpiIndex, address promoter, string memory tag)
        internal
        view
    {
        if (Campaign(campaign).promoterIdOf(promoter) == bytes32(0)) return;
        console.log(
            string.concat(tag, " kpi", vm.toString(kpiIndex), " progress"),
            Campaign(campaign).progressOf(promoter, kpiIndex),
            "tiers",
            Campaign(campaign).settledTiersOf(promoter, kpiIndex)
        );
    }

    // ── the campaigns ────────────────────────────────────────────

    /// @dev Over-delivery, and one promoter who does not.
    ///
    ///      Two KPIs of different kinds so a single campaign already earns two specialization badges,
    ///      and two promoters on the same ladder so the campaign is not a solo record. Promoter 2
    ///      crosses only the first rung on one KPI: "joined 2, delivered on 1" is the honest middle
    ///      case the card's hint under Campaigns Joined exists to describe.
    function _alpha() internal returns (address campaign) {
        uint256 pool = 60_000 * unit;
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Mint);
        kpis[1] = _kpi(Types.KpiKind.Swap);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 2, 5, 9);
        tiers[1] = _tiers(pool, 3, 7, 12);

        campaign = _create(projectAPk, projectA, "sh alpha", pool, kpis, tiers);
        _join(promoter1Pk, campaign);
        _join(promoter2Pk, campaign);

        // Promoter 1 past the top rung of both ladders, spread over four users so "referrals brought"
        // counts more than one wallet per campaign.
        _credit(projectAPk, campaign, 0, promoter1Pk, "alpha.mint.a", 6);
        _credit(projectAPk, campaign, 0, promoter1Pk, "alpha.mint.b", 4);
        _credit(projectAPk, campaign, 1, promoter1Pk, "alpha.swap.a", 8);
        _credit(projectAPk, campaign, 1, promoter1Pk, "alpha.swap.b", 5);

        // Promoter 2 over the first Mint rung and nothing else.
        _credit(projectAPk, campaign, 0, promoter2Pk, "alpha.mint.c", 2);

        console.log("sh alpha      ", campaign);
    }

    /// @dev A ladder the pool cannot pay.
    ///
    ///      The rungs total more than escrow, so the tier that outruns it settles for whatever remains
    ///      and every later one settles for zero. Both are real `TierSettled` events, which is the
    ///      point: the card counts tiers crossed from those, and "31 tiers crossed, 114.6K earned" has
    ///      to survive a tier that paid nothing without the arithmetic disagreeing.
    function _dryrun() internal returns (address campaign) {
        uint256 pool = 900 * unit;
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = _kpi(Types.KpiKind.Deposit);

        // Three rungs at 400 each against a 900 pool: the third can only be paid 100.
        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = new Types.RewardTier[](3);
        tiers[0][0] = Types.RewardTier({threshold: 1, reward: 400 * unit});
        tiers[0][1] = Types.RewardTier({threshold: 3, reward: 400 * unit});
        tiers[0][2] = Types.RewardTier({threshold: 6, reward: 400 * unit});

        campaign = _create(projectAPk, projectA, "sh dryrun", pool, kpis, tiers);
        _join(promoter1Pk, campaign);
        _credit(projectAPk, campaign, 0, promoter1Pk, "dryrun.dep.a", 7);

        console.log("sh dryrun     ", campaign, "(pool exhausted by design)");
    }

    /// @dev Ended by the project before anyone could deliver.
    ///
    ///      `end()` is project-callable at any time, so this is a shape a promoter can be handed
    ///      through no fault of their own — campaign 2 and Gyndore are both real instances of it. The
    ///      card's rule is that such a row explains itself rather than sitting there flat, and this is
    ///      the fixture for that copy.
    function _cutshort() internal returns (address campaign) {
        uint256 pool = 20_000 * unit;
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = _kpi(Types.KpiKind.Stake);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = _tiers(pool, 5, 10, 20);

        campaign = _create(projectAPk, projectA, "sh cutshort", pool, kpis, tiers);
        _join(promoter3Pk, campaign);

        vm.startBroadcast(projectAPk);
        Campaign(campaign).end();
        vm.stopBroadcast();

        console.log("sh cutshort   ", campaign, "(ended immediately)");
    }

    /// @dev The second project, and an aggregate KPI.
    ///
    ///      A different project address is the whole reason this script exists: it is what makes
    ///      "projects worked with" read 2, and what makes the "first repeat project" milestone
    ///      reachable for a wallet that comes back to project A afterwards.
    ///
    ///      KPI 1 is aggregate with **no tiers**, which is the only honest shape for one:
    ///      `reportUserAction` reverts `AggregateKpi` before attribution, so no promoter can ever hold
    ///      progress on it and a ladder there could never pay. Gyndore shipped that mistake with 27,000
    ///      bUSD of rungs behind it; `validation.ts` now blocks it in the form, and the card marks the
    ///      row "not creditable" rather than counting it as a miss.
    function _bravo() internal returns (address campaign) {
        uint256 pool = 40_000 * unit;
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](2);
        kpis[0] = _kpi(Types.KpiKind.Bridge);
        kpis[1] = Types.KpiSpec({
            kind: Types.KpiKind.Volume,
            verifier: address(0),
            target: 1_000_000,
            aggregate: true,
            params: ""
        });

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](2);
        tiers[0] = _tiers(pool, 2, 4, 8);
        tiers[1] = new Types.RewardTier[](0);

        campaign = _create(projectBPk, projectB, "sh bravo", pool, kpis, tiers);
        _join(promoter1Pk, campaign);
        _credit(projectBPk, campaign, 0, promoter1Pk, "bravo.bridge.a", 5);
        _credit(projectBPk, campaign, 0, promoter1Pk, "bravo.bridge.b", 4);

        console.log("sh bravo      ", campaign, "(project B, aggregate KPI)");
    }

    /// @dev Joined and never delivered.
    ///
    ///      Not a failure state and not hidden: joined is the tile value on the card and delivered is
    ///      its hint, so a card nobody can under-fill is a card nobody believes. The per-campaign row
    ///      says "No credited actions yet" for exactly this.
    function _telemetry() internal returns (address campaign) {
        uint256 pool = 15_000 * unit;
        Types.KpiSpec[] memory kpis = new Types.KpiSpec[](1);
        kpis[0] = _kpi(Types.KpiKind.withdraw);

        Types.RewardTier[][] memory tiers = new Types.RewardTier[][](1);
        tiers[0] = _tiers(pool, 4, 8, 16);

        campaign = _create(projectBPk, projectB, "sh telemetry", pool, kpis, tiers);
        _join(promoter2Pk, campaign);

        console.log("sh telemetry  ", campaign, "(joined, never delivered)");
    }

    // ── mechanics ────────────────────────────────────────────────

    /// @dev Fails before spending anything if any name is taken.
    ///
    ///      Names are the only thing making this script non-idempotent — `Names.key` lowercases and the
    ///      registry indexes on it, so a rerun would revert `NameTaken` partway through, after funding
    ///      and possibly after creating some of the five. Checking all five up front turns that into a
    ///      clean refusal.
    function _requireNamesFree() internal view {
        string[5] memory names = ["sh alpha", "sh dryrun", "sh cutshort", "sh bravo", "sh telemetry"];
        for (uint256 i = 0; i < names.length; i++) {
            if (!registry.isNameAvailable(names[i])) {
                console.log("name already taken:", names[i]);
                revert("SeedHistory has already run on this registry");
            }
        }
    }

    /// @dev Gas for the derived accounts, bUSD for project B's escrow, and a top-up for the dev wallet.
    ///
    ///      Project B's allowance is its two pools plus room, transferred rather than approved: it has
    ///      to hold the tokens itself, because `deposit` pulls from `msg.sender` and B is the one
    ///      calling it.
    ///
    ///      Every transfer is guarded on the recipient's balance, so a rerun after a failed broadcast
    ///      re-funds nothing. The first attempt at this died four transactions in — the relay loop was
    ///      running and sends from `PRIVATE_KEY` too, so forge and the relayer picked the same nonce and
    ///      the node rejected the second as an underpriced replacement. Stop the relay before
    ///      broadcasting; the guards are what made retrying free.
    function _fund() internal {
        uint256 escrowForB = 55_000 * unit;

        vm.startBroadcast(projectAPk);
        if (projectB.balance < GAS_FUNDING) payable(projectB).transfer(GAS_FUNDING);
        if (promoter2.balance < GAS_FUNDING) payable(promoter2).transfer(GAS_FUNDING);
        if (promoter3.balance < GAS_FUNDING) payable(promoter3).transfer(GAS_FUNDING);
        if (promoter1.balance < DEV_TOP_UP) payable(promoter1).transfer(DEV_TOP_UP);
        if (token.balanceOf(projectB) < escrowForB) token.transfer(projectB, escrowForB);
        vm.stopBroadcast();
    }

    /// @dev A KPI whose progress is whatever the project reports. See the contract note on why there is
    ///      no verifier and no params.
    function _kpi(Types.KpiKind kind) internal pure returns (Types.KpiSpec memory) {
        return Types.KpiSpec({kind: kind, verifier: address(0), target: 100, aggregate: false, params: ""});
    }

    /// @dev Three ascending rungs at 1% / 2% / 4% of the pool, as `SeedFive` uses — 7% in total, so a
    ///      campaign with two KPIs and two promoters cannot exhaust escrow by accident. `sh dryrun`
    ///      writes its own ladder precisely because it is meant to.
    function _tiers(uint256 pool, uint256 t1, uint256 t2, uint256 t3)
        internal
        pure
        returns (Types.RewardTier[] memory out)
    {
        out = new Types.RewardTier[](3);
        out[0] = Types.RewardTier({threshold: t1, reward: pool / 100});
        out[1] = Types.RewardTier({threshold: t2, reward: pool / 50});
        out[2] = Types.RewardTier({threshold: t3, reward: pool / 25});
    }

    /// @dev Create, fund and activate, as the given project.
    ///
    ///      `minReputation` is 0 throughout. Two of the three promoters here are freshly derived
    ///      wallets with no attestations, so any gate would turn them away — and the card's
    ///      qualification groups are exercised by the live campaigns that already set real gates.
    function _create(
        uint256 pk,
        address project,
        string memory name,
        uint256 pool,
        Types.KpiSpec[] memory kpis,
        Types.RewardTier[][] memory tiers
    ) internal returns (address campaign) {
        Types.CampaignConfig memory cfg = Types.CampaignConfig({
            project: project,
            name: name,
            token: address(token),
            rewardPool: pool,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + DURATION,
            attributionWindow: DURATION,
            minReputation: 0
        });

        vm.startBroadcast(pk);
        (, campaign) = registry.createCampaign(cfg, kpis, tiers);
        token.approve(address(vault), pool);
        vault.deposit(campaign, pool);
        Campaign(campaign).activate();
        vm.stopBroadcast();
    }

    /// @dev The promoter joins, paying their own gas — `join()` reads `msg.sender`, so it cannot be
    ///      relayed. This is also what writes the wallet into `Promoter.wallet` in the subgraph, which
    ///      is what the card queries on.
    function _join(uint256 pk, address campaign) internal {
        vm.startBroadcast(pk);
        Campaign(campaign).join();
        vm.stopBroadcast();
    }

    /// @dev Attribute a derived user to a promoter, then credit them a cumulative total.
    ///
    ///      Two transactions, both sent by the project, which is how the real flow works: the user only
    ///      ever signs. `newTotal` is cumulative per `(user, kpi)` — `reportUserAction` reverts
    ///      `NonMonotonic` on a decrease and returns early on a repeat — so one call per user is enough
    ///      and each distinct user is a distinct referral on the card.
    function _credit(
        uint256 projectPk,
        address campaign,
        uint256 kpiIndex,
        uint256 promoterPk,
        string memory userSeed,
        uint256 total
    ) internal {
        uint256 userPk = _derive(userSeed);
        IAttributionRegistry.Touch memory touch = IAttributionRegistry.Touch({
            campaign: campaign,
            promoterId: Campaign(campaign).promoterIdOf(vm.addr(promoterPk)),
            signedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + TOUCH_LIFETIME
        });

        vm.startBroadcast(projectPk);
        // The project relays its own promoter's touch, which is the arrangement `storeTouch`'s
        // `relayer` argument exists to record.
        attribution.storeTouch(vm.addr(userPk), touch, _signTouch(userPk, touch), vm.addr(projectPk));
        Campaign(campaign).reportUserAction(kpiIndex, vm.addr(userPk), total, "");
        vm.stopBroadcast();
    }

    /// @dev The user's EIP-712 signature over a touch.
    ///
    ///      Its own function to keep `_credit` off the stack limit, and because this is the one piece of
    ///      the flow that has to match `AttributionRegistry` exactly: the typehash and domain separator
    ///      are read from the deployed contract rather than reconstructed, so a redeploy that changes
    ///      either cannot leave this script silently signing something the registry will not recover.
    function _signTouch(uint256 userPk, IAttributionRegistry.Touch memory touch)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                attribution.TOUCH_TYPEHASH(),
                touch.campaign,
                touch.promoterId,
                touch.signedAt,
                touch.expiresAt
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            userPk, keccak256(abi.encodePacked("\x19\x01", attribution.DOMAIN_SEPARATOR(), structHash))
        );
        return abi.encodePacked(r, s, v);
    }

    /// @dev A stable private key from a label. Deterministic so reruns re-derive the same wallets
    ///      rather than scattering history across new addresses, and namespaced so nothing here can
    ///      collide with a key used elsewhere in the repo.
    function _derive(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("boney.seedhistory:", label)));
    }
}

/// @dev `decimals()` is on `IERC20Metadata`, which this script does not otherwise need.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
