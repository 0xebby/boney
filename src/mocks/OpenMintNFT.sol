// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title OpenMintNFT
/// @notice A permissionlessly mintable ERC-721, deployed so a campaign can watch real mints.
/// @dev **Why this exists at all.** Every other source in the demo fixture is a third-party protocol
///      Boney does not control — Sygma, Aave, WETH, Uniswap. An NFT project needs the same, and Base
///      Sepolia does not supply one: a sweep of recent blocks found a single ERC-721 mint, and neither
///      candidate contract (`0x2b2e1bcb…`, `0x2E0033cB…` "Cpeg") exposes a mint anyone can call — every
///      standard entrypoint reverts, with and without value. So this is the one source the fixture
///      deploys itself, chosen over a dead contract that would fail mid-demo.
///
///      **Open on purpose.** No allowlist, no owner gate, no phase — the only requirement is paying
///      `PRICE`. Anything else would need the demo wallet to be provisioned before it could mint, which
///      is the failure mode this replaces.
///
///      ## Two events, because one KPI cannot measure both things
///
///      A campaign here wants "how many minted" *and* "how much was spent", and those need different
///      readings of a log:
///
///       - `Transfer(address(0), to, tokenId)` — inherited from ERC-721, emitted once per token.
///         `topics[2]` is `to`, so `actorTopic: 2` with COUNT credits the minter one unit per token.
///         Its payload cannot be summed: `tokenId` is indexed, so `data` is empty.
///       - `Minted(minter, paid, quantity)` — `paid` is deliberately the **first** non-indexed param,
///         because `indexerCore.rawAmount` reads data word 0 as a raw slice with no ABI decoding. Put
///         `quantity` first and a volume KPI would credit a count instead, silently.
contract OpenMintNFT is ERC721 {
    /// @notice Wei per token. `1e15` scale on the KPI means one mint is exactly one unit of progress.
    uint256 public constant PRICE = 0.001 ether;

    /// @notice Cap per transaction, so a fat-fingered quantity cannot mint the collection dry.
    uint256 public constant MAX_PER_MINT = 20;

    /// @notice Next token id. Starts at 1 so id 0 never exists and cannot be confused with "unset".
    uint256 public nextId = 1;

    /// @notice Total minted, for the UI.
    uint256 public totalMinted;

    /// @notice Recipient of mint proceeds.
    address public immutable beneficiary;

    /// @notice A paid mint, carrying `paid` first so a `dataWord0` KPI sums spend rather than count.
    /// @param minter Wallet that paid and received the tokens — `topics[1]`, so `actorTopic: 1`.
    /// @param paid Wei paid, net of any refund.
    /// @param quantity Tokens minted in this call.
    event Minted(address indexed minter, uint256 paid, uint256 quantity);

    error WrongPayment(uint256 sent, uint256 required);
    error BadQuantity(uint256 quantity, uint256 max);
    error PayoutFailed();

    constructor(address beneficiary_) ERC721("Boney Open Mint", "BOM") {
        beneficiary = beneficiary_ == address(0) ? msg.sender : beneficiary_;
    }

    /// @notice Mint `quantity` tokens to the caller, paying `PRICE` each.
    /// @dev Overpayment reverts rather than being refunded or kept: a refund would make `paid` in the
    ///      event differ from `msg.value` for reasons the log cannot show, and keeping it would
    ///      overstate a spend KPI. Exact payment keeps the credited figure equal to what left the
    ///      wallet.
    /// @param quantity How many to mint, 1 to `MAX_PER_MINT`.
    function mint(uint256 quantity) external payable {
        if (quantity == 0 || quantity > MAX_PER_MINT) revert BadQuantity(quantity, MAX_PER_MINT);

        uint256 required = PRICE * quantity;
        if (msg.value != required) revert WrongPayment(msg.value, required);

        // Minted before the transfer out, so the `Transfer` logs a KPI counts always precede the
        // payout in the receipt regardless of what `beneficiary` does on receive.
        for (uint256 i = 0; i < quantity; ++i) {
            _mint(msg.sender, nextId);
            unchecked {
                ++nextId;
            }
        }
        totalMinted += quantity;

        emit Minted(msg.sender, msg.value, quantity);

        (bool ok,) = beneficiary.call{value: msg.value}("");
        if (!ok) revert PayoutFailed();
    }

    /// @notice Cost of minting `quantity`, so a caller need not assume `PRICE`.
    function quote(uint256 quantity) external pure returns (uint256) {
        return PRICE * quantity;
    }
}
