// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Names
/// @notice Validation and normalization for human-readable campaign names.
/// @dev Split out as a pure library so the rules are unit-testable on their own, and so `Campaign`
///      (which validates) and `CampaignRegistry` (which enforces uniqueness) cannot drift into two
///      different definitions of what a name is.
///
///      **Why normalize at all.** Uniqueness on raw bytes is trivially defeated by accident:
///      "Aave", "aave" and "Aave " are three distinct byte strings that read as the same name to a
///      person, so a raw-bytes index would let three campaigns claim what looks like one Campaign Title.

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
            // 0x20 (space) through 0x7E (~). Excludes control characters, DEL, and every byte with
            // the high bit set — which is all of UTF-8's multi-byte space.
            if (c < 0x20 || c > 0x7E) revert InvalidNameChar(i, raw[i]);
            if (c != 0x20) hasVisible = true;
        }

        if (!hasVisible) revert EmptyName();
    }

    /// @notice The uniqueness key for `name`: trimmed, inner spaces collapsed, lowercased, hashed.
    /// @dev Validates first, so an invalid name can never claim a key. Returns a hash rather than
    ///      the normalized string because the registry indexes on it and `bytes32` is one slot.
    /// @param name The raw name as supplied by the creator.
    /// @return The keccak256 hash of the normalized form.
    function key(string memory name) internal pure returns (bytes32) {
        validate(name);
        return keccak256(normalize(name));
    }

    /// @notice The normalized form of `name`, as bytes.
    /// @dev Exposed alongside `key` so tests can assert on the normalization itself rather than
    ///      only on hash equality — a hash tells you two names collide but not what they became.
    ///
    ///      Assumes `validate` has passed (or does not care): it treats any byte other than 0x20 as
    ///      a visible character, and only folds A-Z. Callers wanting the guarantee use `key`.
    /// @param name The raw name.
    /// @return out The trimmed, space-collapsed, lowercased bytes.
    function normalize(string memory name) internal pure returns (bytes memory out) {
        bytes memory raw = bytes(name);

        uint256 start;
        uint256 end = raw.length;
        while (start < end && raw[start] == 0x20) ++start;
        while (end > start && raw[end - 1] == 0x20) --end;

        // Sized to the trimmed span, then shortened in place: collapsing runs of spaces can only
        // make the result smaller, and assembly-truncating one buffer avoids a second pass to count.
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
