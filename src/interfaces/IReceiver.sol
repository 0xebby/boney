// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver
/// @notice Callback surface used by the Keystone forwarder.
interface IReceiver is IERC165 {
    /// @notice Receive one verified CRE report.
    /// @param metadata Keystone workflow metadata.
    /// @param report Workflow report payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
