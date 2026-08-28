// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Names
/// @notice Validation and normalization for human-readable campaign names.
/// @dev A pure library, so `Campaign` (which validates) and `CampaignRegistry` (which enforces
///      uniqueness) share one definition of what a name is. Normalization folds case and collapses
///      whitespace, so "Aave", "aave" and "Aave " are one name rather than three.
library Names {
    /// @dev Raised when a name is empty, or is nothing but spaces (which normalizes to empty).
    error EmptyName();
    /// @dev Raised when a name exceeds `MAX_NAME_BYTES`.
    error NameTooLong(uint256 got, uint256 max);
    /// @dev Raised on the first byte outside printable ASCII, with its position for a useful UI.
    error InvalidNameChar(uint256 index, bytes1 char);

    /// @notice Longest name a campaign may carry, in bytes (== characters, ASCII-only).
    uint256 internal constant MAX_NAME_BYTES = 32;

    /// @notice Reverts unless `name` is non-empty, within length, and printable ASCII throughout.
    /// @param name The raw name as supplied by the creator.
    function validate(string memory name) internal pure {
        bytes memory raw = bytes(name);
        if (raw.length == 0) revert EmptyName();
        if (raw.length > MAX_NAME_BYTES) revert NameTooLong(raw.length, MAX_NAME_BYTES);

        bool hasVisible;
        for (uint256 i; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            // 0x20 (space) through 0x7E (~): excludes control characters, DEL, and all multi-byte UTF-8.
            if (c < 0x20 || c > 0x7E) revert InvalidNameChar(i, raw[i]);
            if (c != 0x20) hasVisible = true;
        }

        if (!hasVisible) revert EmptyName();
    }

    /// @notice The uniqueness key for `name`: trimmed, inner spaces collapsed, lowercased, hashed.
    /// @dev Validates first, so an invalid name can never claim a key.
    /// @param name The raw name as supplied by the creator.
    /// @return The keccak256 hash of the normalized form.
    function key(string memory name) internal pure returns (bytes32) {
        validate(name);
        return keccak256(normalize(name));
    }

    /// @notice The normalized form of `name`, as bytes.
    /// @dev Does not validate: treats any byte other than 0x20 as visible, and folds only A-Z.
    ///      Callers wanting the validation guarantee use `key`.
    /// @param name The raw name.
    /// @return out The trimmed, space-collapsed, lowercased bytes.
    function normalize(string memory name) internal pure returns (bytes memory out) {
        bytes memory raw = bytes(name);

        uint256 start;
        uint256 end = raw.length;
        while (start < end && raw[start] == 0x20) ++start;
        while (end > start && raw[end - 1] == 0x20) --end;

        // Sized to the trimmed span, then shortened in place; collapsing spaces only shrinks it.
        out = new bytes(end - start);
        uint256 n;
        bool previousWasSpace;
        for (uint256 i = start; i < end; ++i) {
            bytes1 b = raw[i];
            if (b == 0x20) {
                if (previousWasSpace) continue; // Collapse the run.
                previousWasSpace = true;
                out[n++] = b;
                continue;
            }
            previousWasSpace = false;
            uint8 c = uint8(b);
            // ASCII 'A'-'Z' -> 'a'-'z'. Every other byte is left as it is.
            out[n++] = (c >= 0x41 && c <= 0x5A) ? bytes1(c + 32) : b;
        }

        if (n != out.length) {
            assembly {
                mstore(out, n)
            }
        }
    }
}
