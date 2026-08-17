// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ICompliance} from "./interfaces/ICompliance.sol";

/**
 * @title Compliance
 * @notice One policy contract serving many tokens. It answers a single question
 *         per address — may this address participate — and refuses for three
 *         reasons: a per-token block, a global sanction, or a time-boxed freeze.
 *
 *         Everything here is a negative list. Verification happens off-chain,
 *         where the evidence lives; the chain carries only refusals, so a new
 *         holder is permitted by default and no on-chain KYC state can go stale
 *         against the record it was derived from.
 *
 *         Sanctions use an epoch. Bumping the epoch invalidates every prior
 *         sanction in constant gas, however long the list was, which is what
 *         makes wholesale replacement of a published list affordable.
 */
contract Compliance is ICompliance, AccessControlDefaultAdminRules {
    uint256 public constant MAX_BATCH_SIZE = 200;

    /// @notice Compliance officers.
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    /// @notice Blocks scoped to one token. `address(0)` blocks across all tokens.
    mapping(address token => mapping(address user => bool)) public blockedAddresses;

    /// @notice Freeze expiry per token and holder. Zero means not frozen; a
    ///         timestamp in the past means the freeze has lapsed. A freeze under
    ///         `address(0)` applies to every token.
    mapping(address token => mapping(address user => uint64 until)) public frozenUntil;

    /// Starts at 1 so the default mapping value of 0 is never an active epoch
    /// and can serve as the explicit "not sanctioned" sentinel.
    uint256 private _sanctionEpoch;
    mapping(address user => uint256 epoch) private _sanctionedInEpoch;

    event BlocklistUpdated(address indexed token, address[] accounts, bool blocked);
    event SanctionsAdded(uint256 indexed epoch, address[] accounts);
    event SanctionsRemoved(uint256 indexed epoch, address[] accounts);
    event SanctionsReset(uint256 indexed epoch);
    event FreezeSet(address indexed token, address indexed account, uint64 until);

    error UserBlocked(address user);
    error UserSanctioned(address user);
    error UserFrozen(address user, uint64 until);
    error EmptyAccounts();
    error BatchTooLarge(uint256 length);
    error ZeroAddress();
    error FreezeInPast();
    error UnauthorizedComplianceOperator(address account);

    modifier onlyComplianceOfficer() {
        if (!_isComplianceOfficer(_msgSender())) revert UnauthorizedComplianceOperator(_msgSender());
        _;
    }

    modifier onlyOperatorFor(address token) {
        address caller = _msgSender();
        if (
            !_isComplianceOfficer(caller)
                && (token == address(0) || !hasRole(opsRole(token), caller))
        ) {
            revert UnauthorizedComplianceOperator(caller);
        }
        _;
    }

    constructor(address admin) AccessControlDefaultAdminRules(1 hours, admin) {
        _sanctionEpoch = 1;
    }

    // ── Checks ────────────────────────────────────────────────────────────────

    /// @inheritdoc ICompliance
    function checkIsCompliant(address token, address user) external view {
        _check(token, user);
    }

    /// @inheritdoc ICompliance
    function checkTransfer(address token, address operator, address from, address to, uint256)
        external
        view
    {
        if (operator != address(0)) _check(token, operator);
        if (from != address(0) && from != operator) _check(token, from);
        if (to != address(0) && to != operator && to != from) _check(token, to);
    }

    /// @notice Non-reverting form, for callers that need a flag rather than a
    ///         revert — a UI deciding whether to offer a transfer, for instance.
    function isCompliant(address token, address user) external view returns (bool) {
        if (blockedAddresses[token][user] || blockedAddresses[address(0)][user]) return false;
        if (_sanctionedInEpoch[user] == _sanctionEpoch) return false;
        return _freezeExpiry(token, user) <= block.timestamp;
    }

    function isSanctioned(address user) external view returns (bool) {
        return _sanctionedInEpoch[user] == _sanctionEpoch;
    }

    function sanctionEpoch() external view returns (uint256) {
        return _sanctionEpoch;
    }

    // ── Blocklist ─────────────────────────────────────────────────────────────

    /// @notice Token operators may impose blocks; only compliance officers may lift them.
    function setBlocked(address token, address[] calldata accounts, bool blocked)
        external
        onlyOperatorFor(token)
    {
        if (!blocked && !_isComplianceOfficer(_msgSender())) {
            revert UnauthorizedComplianceOperator(_msgSender());
        }
        _validateBatch(accounts);

        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            blockedAddresses[token][accounts[i]] = blocked;
        }
        emit BlocklistUpdated(token, accounts, blocked);
    }

    // ── Sanctions ─────────────────────────────────────────────────────────────

    function addSanctions(address[] calldata accounts) external onlyComplianceOfficer {
        _validateBatch(accounts);

        uint256 epoch = _sanctionEpoch;
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            _sanctionedInEpoch[accounts[i]] = epoch;
        }
        emit SanctionsAdded(epoch, accounts);
    }

    function removeSanctions(address[] calldata accounts) external onlyComplianceOfficer {
        _validateBatch(accounts);

        uint256 epoch = _sanctionEpoch;
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            // Zero is the sentinel for "never sanctioned", so clearing to zero
            // is correct whatever the current epoch happens to be.
            _sanctionedInEpoch[accounts[i]] = 0;
        }
        emit SanctionsRemoved(epoch, accounts);
    }

    /// @notice Clears every sanction at once by moving to a fresh epoch.
    function resetSanctions() external onlyComplianceOfficer {
        uint256 epoch = ++_sanctionEpoch;
        emit SanctionsReset(epoch);
    }

    /// @notice Replaces the list wholesale: a fresh epoch retires all previous
    ///         entries, then `accounts` are written into it. Duplicates are harmless.
    function setSanctions(address[] calldata accounts) external onlyComplianceOfficer {
        _validateBatch(accounts);
        uint256 epoch = ++_sanctionEpoch;

        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            _sanctionedInEpoch[accounts[i]] = epoch;
        }
        emit SanctionsReset(epoch);
        emit SanctionsAdded(epoch, accounts);
    }

    // ── Freezes ───────────────────────────────────────────────────────────────

    /// @notice Freezes `account` for `token` until `until`. Token operators may
    ///         impose or extend; only compliance officers may shorten or lift.
    ///         Pass `token == address(0)` for global scope and `until == 0` to lift.
    function setFreeze(address token, address account, uint64 until) external onlyOperatorFor(token) {
        if (account == address(0)) revert ZeroAddress();
        if (until != 0 && until <= block.timestamp) revert FreezeInPast();
        if (
            !_isComplianceOfficer(_msgSender())
                && (until == 0 || until < frozenUntil[token][account])
        ) {
            revert UnauthorizedComplianceOperator(_msgSender());
        }

        frozenUntil[token][account] = until;
        emit FreezeSet(token, account, until);
    }

    function opsRole(address token) public pure returns (bytes32) {
        if (token == address(0)) revert ZeroAddress();
        return keccak256(abi.encodePacked("OPS_ROLE", token));
    }

    function _check(address token, address user) private view {
        if (blockedAddresses[token][user] || blockedAddresses[address(0)][user]) {
            revert UserBlocked(user);
        }
        if (_sanctionedInEpoch[user] == _sanctionEpoch) revert UserSanctioned(user);

        uint64 until = _freezeExpiry(token, user);
        if (until > block.timestamp) revert UserFrozen(user, until);
    }

    /// @dev Returns the later of a token freeze and a global freeze.
    function _freezeExpiry(address token, address user) private view returns (uint64) {
        uint64 tokenFreeze = frozenUntil[token][user];
        uint64 globalFreeze = frozenUntil[address(0)][user];
        return tokenFreeze > globalFreeze ? tokenFreeze : globalFreeze;
    }

    function _isComplianceOfficer(address account) private view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account) || hasRole(COMPLIANCE_ROLE, account);
    }

    function _validateBatch(address[] calldata accounts) private pure {
        if (accounts.length == 0) revert EmptyAccounts();
        if (accounts.length > MAX_BATCH_SIZE) revert BatchTooLarge(accounts.length);
    }
}
