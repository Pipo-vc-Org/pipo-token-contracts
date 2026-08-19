// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ICompliance
 * @notice Transfer-aware policy consulted once for every token balance update.
 */
interface ICompliance {
    /// @notice Current authority governing policy state.
    function policyAuthority() external view returns (address);

    /// @notice Reverts if the complete transfer, mint or burn is not permitted.
    function checkTransfer(address token, address operator, address from, address to, uint256 value)
        external
        view;

    /// @notice Reverts if one address is not permitted; useful for direct policy queries.
    function checkIsCompliant(address token, address user) external view;
}
