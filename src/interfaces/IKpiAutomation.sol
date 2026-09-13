// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IKpiAutomation
/// @notice Declares how a custom KPI can be automated.
interface IKpiAutomation {
    /// @notice Automation route supported by a KPI verifier.
    enum AutomationMode {
        UNSUPPORTED,
        USER_EVIDENCE_FREE,
        USER_ACTIONS,
        AGGREGATE
    }

    /// @notice Return a KPI's automation route and observation adapter.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @return mode Supported automation route.
    /// @return observationAdapter Adapter exposing canonical observations.
    function automationCapability(address campaign, uint256 kpiIndex)
        external
        view
        returns (AutomationMode mode, address observationAdapter);
}

/// @title IKpiAutomationObservation
/// @notice Exposes canonical observations for custom KPI automation.
interface IKpiAutomationObservation {
    /// @notice Return the active observation generation.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @return The active generation.
    function observationEpoch(address campaign, uint256 kpiIndex) external view returns (uint256);

    /// @notice Return one user's canonical cumulative progress.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @param user User whose progress is returned.
    /// @return The observed cumulative progress.
    function observedProgressOf(address campaign, uint256 kpiIndex, address user)
        external
        view
        returns (uint256);

    /// @notice Return canonical campaign-level progress.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @return The observed aggregate progress.
    function observedAggregateProgressOf(address campaign, uint256 kpiIndex)
        external
        view
        returns (uint256);
}

/// @title IEventMetricAutomation
/// @notice Exposes EventMetric configuration used by automation routers.
interface IEventMetricAutomation {
    /// @notice EventMetric configuration fields needed by automation.
    struct KpiConfig {
        address targetContract;
        string eventSignature;
        uint8 userParamIndex;
        uint8 valueParamIndex;
        uint8 aggregation;
        uint256 scale;
        uint256 windowStartBlock;
        uint256 windowEndBlock;
        bool configured;
        uint256 epoch;
    }

    /// @notice Return one KPI's EventMetric configuration.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @return The stored configuration.
    function configOf(address campaign, uint256 kpiIndex) external view returns (KpiConfig memory);

    /// @notice Return one user's scaled canonical progress.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @param user User whose progress is returned.
    /// @return The observed cumulative progress.
    function observedProgressOf(address campaign, uint256 kpiIndex, address user)
        external
        view
        returns (uint256);
}

/// @title IGuardedAutomation
/// @notice Exposes guarded-verifier routing metadata.
interface IGuardedAutomation {
    /// @notice Return the canonical outer verifier.
    /// @return The canonical verifier address.
    function boneyVerifier() external view returns (address);

    /// @notice Return one KPI's guard configuration.
    /// @param campaign Campaign the KPI belongs to.
    /// @param kpiIndex Index of the KPI within the campaign.
    /// @return projectVerifier Optional secondary verifier.
    /// @return toleranceBps Allowed agreement tolerance.
    /// @return mode Verifier composition mode.
    /// @return configured Whether the guard is configured.
    function guardOf(address campaign, uint256 kpiIndex)
        external
        view
        returns (address projectVerifier, uint16 toleranceBps, uint8 mode, bool configured);
}
