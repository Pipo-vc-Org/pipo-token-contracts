// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Compliance} from "./Compliance.sol";
import {ICompliance} from "./interfaces/ICompliance.sol";

/**
 * @title PipoSecurityToken
 * @notice Non-upgradeable security token with immutable instrument identity,
 *         administered terms, transfer compliance and aggregate lock-ups.
 */
contract PipoSecurityToken is ERC20, ERC20Permit, ERC20Pausable, AccessControlDefaultAdminRules {
    struct Lockup {
        uint256 amount;
        uint64 releaseAt;
    }

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint64 public constant ADMIN_COOLDOWN = 1 hours;

    /// @notice Independent compliance-governance address; intended to be a multisig.
    address public immutable POLICY_AUTHORITY;
    /// @notice Independent authority approving issuer-to-recipient mint quotas.
    address public immutable ISSUANCE_AUTHORITY;

    ICompliance public compliance;
    bool public mintEnabled = true;
    bool public burnEnabled = true;
    uint64 public unpauseAvailableAt;
    bytes32 public complianceCodehash;
    mapping(address issuer => mapping(address recipient => uint256 remaining)) public mintAllowance;

    mapping(address holder => Lockup lockup) private _lockups;

    /// @notice Immutable securities identifier — ISIN, CUSIP or internal reference.
    string public identifier;
    /// @notice Pointer to the currently governing token terms.
    string public termsUri;

    event ComplianceUpdated(address indexed previousCompliance, address indexed newCompliance);
    event ComplianceCodehashUpdated(bytes32 indexed previousCodehash, bytes32 indexed newCodehash);
    event MintAllowanceUpdated(
        address indexed issuer, address indexed recipient, uint256 previousAllowance, uint256 newAllowance
    );
    event MintingFinalized();
    event BurnEnabledUpdated(bool enabled);
    event LockupSet(address indexed holder, uint256 amount, uint64 releaseAt);
    event TermsUriChanged(string previousTermsUri, string newTermsUri);
    event UnpauseScheduled(uint64 availableAt);

    error EmptyName();
    error EmptySymbol();
    error EmptyIdentifier();
    error EmptyTermsUri();
    error InvalidIssuer();
    error InvalidBurner();
    error InvalidPauser();
    error InvalidPolicyAuthority();
    error InvalidIssuanceAuthority();
    error InvalidMintRecipient();
    error InvalidCompliance();
    error ComplianceUnchanged();
    error InvalidDefaultAdmin();
    error MintAllowanceExceeded(uint256 available);
    error MintAllowanceChanged(uint256 current);
    error MintDisabled();
    error MintingAlreadyFinalized();
    error BurnDisabled();
    error InvalidLockupHolder();
    error LockupInPast();
    error LockupCannotWeaken();
    error LockedBalance(uint256 locked);
    error InvalidTokenRecipient();
    error UnpauseCooldown(uint64 availableAt);
    error UnauthorizedPolicyAuthority(address account);
    error UnauthorizedIssuanceAuthority(address account);

    modifier onlyPolicyAuthority() {
        if (_msgSender() != POLICY_AUTHORITY) revert UnauthorizedPolicyAuthority(_msgSender());
        _;
    }

    modifier onlyIssuanceAuthority() {
        if (_msgSender() != ISSUANCE_AUTHORITY) revert UnauthorizedIssuanceAuthority(_msgSender());
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        string memory identifier_,
        string memory termsUri_,
        address admin_,
        address issuer_,
        address burner_,
        address pauser_,
        address policyAuthority_,
        address issuanceAuthority_,
        address compliance_
    ) ERC20(name_, symbol_) ERC20Permit(name_) AccessControlDefaultAdminRules(1 hours, admin_) {
        if (bytes(name_).length == 0) revert EmptyName();
        if (bytes(symbol_).length == 0) revert EmptySymbol();
        if (bytes(identifier_).length == 0) revert EmptyIdentifier();
        if (bytes(termsUri_).length == 0) revert EmptyTermsUri();
        if (issuer_ == address(0) || issuer_ == admin_) revert InvalidIssuer();
        if (burner_ == address(0) || burner_ == admin_ || burner_ == issuer_) {
            revert InvalidBurner();
        }
        if (
            pauser_ == address(0) || pauser_ == admin_ || pauser_ == issuer_
                || pauser_ == burner_
        ) revert InvalidPauser();
        if (
            policyAuthority_ == address(0) || policyAuthority_ == admin_
                || policyAuthority_ == issuer_ || policyAuthority_ == burner_
                || policyAuthority_ == pauser_
        ) {
            revert InvalidPolicyAuthority();
        }
        if (
            issuanceAuthority_ == address(0) || issuanceAuthority_ == admin_
                || issuanceAuthority_ == issuer_ || issuanceAuthority_ == burner_
                || issuanceAuthority_ == pauser_ || issuanceAuthority_ == policyAuthority_
        ) {
            revert InvalidIssuanceAuthority();
        }
        bytes32 bundledCodehash = keccak256(type(Compliance).runtimeCode);
        _validateCompliance(compliance_, bundledCodehash, policyAuthority_);

        compliance = ICompliance(compliance_);
        complianceCodehash = bundledCodehash;
        POLICY_AUTHORITY = policyAuthority_;
        ISSUANCE_AUTHORITY = issuanceAuthority_;
        identifier = identifier_;
        termsUri = termsUri_;

        _grantRole(ISSUER_ROLE, issuer_);
        _grantRole(BURNER_ROLE, burner_);
        _grantRole(PAUSER_ROLE, pauser_);
    }

    /// @notice Issues only the quota approved for this issuer and recipient.
    function mint(address recipient, uint256 amount) external onlyRole(ISSUER_ROLE) {
        if (!mintEnabled) revert MintDisabled();
        uint256 available = mintAllowance[_msgSender()][recipient];
        if (amount > available) revert MintAllowanceExceeded(available);
        mintAllowance[_msgSender()][recipient] = available - amount;
        emit MintAllowanceUpdated(_msgSender(), recipient, available, available - amount);
        _mint(recipient, amount);
    }

    /// @notice Sets the remaining amount one issuer may mint to one recipient.
    function setMintAllowance(
        address issuer,
        address recipient,
        uint256 expectedCurrent,
        uint256 amount
    )
        external
        onlyIssuanceAuthority
    {
        if (!hasRole(ISSUER_ROLE, issuer) || issuer == ISSUANCE_AUTHORITY) revert InvalidIssuer();
        if (recipient == address(0) || recipient == address(this)) revert InvalidMintRecipient();
        uint256 previousAllowance = mintAllowance[issuer][recipient];
        if (previousAllowance != expectedCurrent) revert MintAllowanceChanged(previousAllowance);
        mintAllowance[issuer][recipient] = amount;
        emit MintAllowanceUpdated(issuer, recipient, previousAllowance, amount);
    }

    /// @notice Irreversibly closes issuance.
    function finalizeMinting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!mintEnabled) revert MintingAlreadyFinalized();
        mintEnabled = false;
        emit MintingFinalized();
    }

    /// @notice Retires the caller's own returned supply.
    function burn(uint256 amount) external onlyRole(BURNER_ROLE) {
        if (!burnEnabled) revert BurnDisabled();
        _burn(_msgSender(), amount);
    }

    function setBurnEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        burnEnabled = enabled;
        emit BurnEnabledUpdated(enabled);
    }

    /// @notice Atomically approves and installs one governed policy during a pause.
    function setCompliance(address policy, bytes32 expectedCodehash)
        external
        onlyPolicyAuthority
        whenPaused
    {
        address previousCompliance = address(compliance);
        bytes32 previousCodehash = complianceCodehash;
        if (policy == previousCompliance && expectedCodehash == previousCodehash) {
            revert ComplianceUnchanged();
        }
        _validateCompliance(policy, expectedCodehash, POLICY_AUTHORITY);
        compliance = ICompliance(policy);
        complianceCodehash = expectedCodehash;
        _scheduleUnpause();
        emit ComplianceCodehashUpdated(previousCodehash, expectedCodehash);
        emit ComplianceUpdated(previousCompliance, policy);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        _scheduleUnpause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint64 availableAt = unpauseAvailableAt;
        if (block.timestamp < availableAt) revert UnpauseCooldown(availableAt);
        _validateCompliance(address(compliance), complianceCodehash, POLICY_AUTHORITY);
        unpauseAvailableAt = 0;
        _unpause();
    }

    /// @notice Updates governing terms during a pause and starts the cooldown.
    function setTermsUri(string calldata termsUri_) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (bytes(termsUri_).length == 0) revert EmptyTermsUri();
        emit TermsUriChanged(termsUri, termsUri_);
        termsUri = termsUri_;
        _scheduleUnpause();
    }

    /**
     * @notice Sets the aggregate amount immobilised until `releaseAt`.
     *         During normal operation an active lock may only strengthen.
     *         Weakening or clearing it requires a pause and restarts the cooldown.
     */
    function setLockup(address holder, uint256 amount, uint64 releaseAt)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (holder == address(0)) revert InvalidLockupHolder();

        Lockup storage current = _lockups[holder];
        bool active = current.amount != 0 && current.releaseAt > block.timestamp;
        bool weakening = active
            && (amount == 0 || amount < current.amount || releaseAt < current.releaseAt);
        if (weakening) {
            if (!paused()) revert LockupCannotWeaken();
            _scheduleUnpause();
        }
        if (amount == 0) {
            delete _lockups[holder];
            emit LockupSet(holder, 0, 0);
            return;
        }
        if (releaseAt <= block.timestamp) revert LockupInPast();

        _lockups[holder] = Lockup({amount: amount, releaseAt: releaseAt});
        emit LockupSet(holder, amount, releaseAt);
    }

    function availableBalanceOf(address holder) external view returns (uint256) {
        return _available(balanceOf(holder), lockedBalanceOf(holder));
    }

    /// @notice Schedules only a non-zero successor; this token must remain administered.
    function beginDefaultAdminTransfer(address newAdmin)
        public
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newAdmin == address(0)) revert InvalidDefaultAdmin();
        _beginDefaultAdminTransfer(newAdmin);
    }

    function lockedBalanceOf(address holder) public view returns (uint256) {
        Lockup storage lockup = _lockups[holder];
        if (lockup.releaseAt <= block.timestamp) return 0;
        return lockup.amount;
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        _requireNotPaused();
        if (to == address(this)) revert InvalidTokenRecipient();
        compliance.checkTransfer(address(this), _msgSender(), from, to, value);

        if (from != address(0)) {
            uint256 locked = lockedBalanceOf(from);
            if (locked != 0) {
                uint256 available = _available(balanceOf(from), locked);
                if (value > available) revert LockedBalance(locked);
            }
        }
        // The pause check is intentionally lifted above the external policy call.
        // Call ERC20 directly so ERC20Pausable does not repeat it afterwards.
        ERC20._update(from, to, value);
    }

    function _scheduleUnpause() private {
        uint64 availableAt = uint64(block.timestamp + ADMIN_COOLDOWN);
        unpauseAvailableAt = availableAt;
        emit UnpauseScheduled(availableAt);
    }

    function _validateCompliance(address policy, bytes32 expectedCodehash, address expectedAuthority)
        private
        view
    {
        if (policy == address(0) || policy.code.length == 0 || policy.codehash != expectedCodehash) {
            revert InvalidCompliance();
        }
        (bool success, bytes memory result) = policy.staticcall(
            abi.encodeCall(ICompliance.policyAuthority, ())
        );
        if (!success || result.length != 32) revert InvalidCompliance();
        if (abi.decode(result, (address)) != expectedAuthority) revert InvalidPolicyAuthority();
    }

    function _available(uint256 balance, uint256 locked) private pure returns (uint256) {
        return balance > locked ? balance - locked : 0;
    }
}
