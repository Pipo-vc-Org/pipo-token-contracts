// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICompliance} from "../interfaces/ICompliance.sol";

/// @notice Valid alternate policy used to test explicit codehash approval.
contract MockCompliance is ICompliance {
    address private immutable _POLICY_AUTHORITY;
    bool public refuseAll;
    mapping(address user => bool refused) public refused;
    bool public shouldRevert;
    string public reason = "Participant not permitted";

    error Refused(address user, string reason);
    error PolicyUnavailable();

    constructor(address policyAuthority_) {
        _POLICY_AUTHORITY = policyAuthority_;
    }

    function setRefuseAll(bool value, string calldata reason_) external {
        refuseAll = value;
        reason = reason_;
    }

    function setRefused(address user, bool value) external {
        refused[user] = value;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function checkTransfer(address, address operator, address from, address to, uint256) external view {
        if (operator != from && operator != to) _check(operator);
        if (from != address(0)) _check(from);
        if (to != address(0) && to != from) _check(to);
    }

    function checkIsCompliant(address, address user) external view {
        _check(user);
    }

    function policyAuthority() external view returns (address) {
        return _POLICY_AUTHORITY;
    }

    function _check(address user) private view {
        if (shouldRevert) revert PolicyUnavailable();
        if (refuseAll || refused[user]) revert Refused(user, reason);
    }
}

/// @notice Legacy-shaped dispatcher: known selector gets the old marker and
///         every other selector succeeds with empty returndata.
contract LegacySelectorFallbackPolicy {
    fallback(bytes calldata input) external returns (bytes memory) {
        if (bytes4(input) == bytes4(keccak256("complianceMagic()"))) {
            return abi.encode(bytes4(keccak256("ICompliance.v1")));
        }
        return "";
    }
}
