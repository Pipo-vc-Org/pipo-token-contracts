# PIPO security-token contracts

This repository contains the non-upgradeable ERC-20 security token used by the PIPO platform and the shared negative-list policy that authorizes its balance updates.

The package is deliberately limited to on-chain token and policy logic. Deployment infrastructure, production addresses, key custody, multisig configuration, off-chain KYC evidence, offering and payment flows, custody, and legal-document workflows live outside this repository.

## Repository structure

| Path | Purpose |
|---|---|
| `contracts/PipoSecurityToken.sol` | ERC-20 token, supply controls, pause and maintenance controls, policy hook, permit, and aggregate holder lock-ups. |
| `contracts/Compliance.sol` | Shared block, sanctions, and freeze policy for one or more tokens. |
| `contracts/interfaces/ICompliance.sol` | Transfer-context interface between a token and a policy. |
| `contracts/mocks/MockCompliance.sol` | Test-only policies, including deliberately malformed fixtures. |
| `test/PipoSecurityToken.test.ts` | Token behavior, authority, maintenance, lock-up, policy, and permit tests. |
| `test/Compliance.test.ts` | Policy behavior, batch validation, token-scoped roles, sanctions, and default-admin tests. |
| `hardhat.config.ts` | Solidity compiler, Hardhat network, coverage, type generation, and gas-reporting configuration. |
| `package.json` / `package-lock.json` | Reproducible Node.js toolchain and dependency graph. |

## Architecture

`PipoSecurityToken` is deployed directly. It is not a proxy, clone, or upgradeable implementation. Its ERC-20 balance changes all pass through `_update`, which:

1. rejects every balance update while paused before making an external call;
2. rejects a transfer whose recipient is the token contract itself;
3. calls the active policy once with the full operation context;
4. enforces the sender's active aggregate lock-up; and
5. applies the ERC-20 balance update.

The policy call is:

```solidity
checkTransfer(token, operator, from, to, value)
```

`from == address(0)` identifies minting and `to == address(0)` identifies burning. For `transferFrom`, `operator` is the allowance spender. The bundled `Compliance` implementation checks each distinct non-zero participant and fails closed by reverting.

`Compliance` is shared across tokens. It is a negative-list policy: an address is permitted unless a per-token or global block, a global sanction, or a per-token or global freeze refuses it. Eligibility evidence and positive KYC records remain off-chain.

The token stores two separate policy values:

- `compliance`: the policy currently called by `_update`;
- `complianceCodehash`: the one runtime-code hash currently approved for installation.

At deployment, the approved hash is `keccak256(type(Compliance).runtimeCode)`, and the initial policy address must have exactly that runtime code. Its default admin must equal the token's independent `policyAuthority`. Later policy-code approval and policy installation can be performed only by that authority while the token is paused. Both restart the one-hour unpause cooldown; the token default admin cannot grant itself this authority.

## PipoSecurityToken

### Constructor

```solidity
constructor(
    string name_,
    string symbol_,
    string identifier_,
    string termsUri_,
    address admin_,
    address issuer_,
    address burner_,
    address pauser_,
    address policyAuthority_,
    address issuanceAuthority_,
    address compliance_
)
```

| Argument | Requirement and effect |
|---|---|
| `name_` | Non-empty ERC-20 name and immutable EIP-712 permit-domain name. |
| `symbol_` | Non-empty ERC-20 symbol. |
| `identifier_` | Non-empty immutable instrument identifier, such as an ISIN, CUSIP, or internal reference. |
| `termsUri_` | Non-empty initial pointer to the governing terms. The contract does not validate its URI scheme or content hash. |
| `admin_` | Initial default admin under `AccessControlDefaultAdminRules`, with a one-hour admin-transfer delay. OpenZeppelin validates this address. |
| `issuer_` | Non-zero initial holder of `ISSUER_ROLE`. |
| `burner_` | Non-zero initial holder of `BURNER_ROLE`; must differ from `issuer_`. |
| `pauser_` | Non-zero initial holder of `PAUSER_ROLE`. |
| `policyAuthority_` | Stable non-zero compliance-governance address, distinct from `admin_`; intended to be a multisig whose signer rotation does not change its address. |
| `issuanceAuthority_` | Stable non-zero address that approves recipient-bound mint allowances; distinct from the token admin, initial issuer, and policy authority. Intended to be a multisig. |
| `compliance_` | Deployed bundled `Compliance`; its runtime codehash must match and its initial default admin must equal `policyAuthority_`. |

Deployment starts with minting and burning enabled, no supply, and no lock-ups.

### Token roles

| Role | Authority |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Administers token roles; finalizes minting; controls the burn switch, lock-ups, and terms; unpauses after the cooldown. It cannot approve or install policy code. |
| `ISSUER_ROLE` | Calls `mint(recipient, amount)` within the remaining allowance independently approved for that issuer and recipient. |
| `BURNER_ROLE` | Calls `burn(amount)`, which can burn only the caller's own returned balance. |
| `PAUSER_ROLE` | May pause. It cannot unpause. |
| `POLICY_AUTHORITY` | Immutable independent address, not an AccessControl role. While paused, it approves policy codehashes and installs policy addresses. |
| `ISSUANCE_AUTHORITY` | Immutable independent address, not an AccessControl role. Approves or cancels issuer-to-recipient mint allowances. |

The constructor assigns issuer and burner to different addresses. The admin may later grant or revoke ordinary token roles, but cannot acquire `policyAuthority` through AccessControl. Transfer of `DEFAULT_ADMIN_ROLE` follows the delayed two-step process described below.

### Token API

Project-specific state and getters:

| API | Meaning |
|---|---|
| `ISSUER_ROLE()`, `BURNER_ROLE()`, `PAUSER_ROLE()` | Role identifiers. |
| `ADMIN_COOLDOWN()` | One-hour minimum wait before admin unpause after the latest scheduled maintenance action. |
| `identifier()` | Immutable instrument identifier supplied at construction. |
| `termsUri()` | Current governing-terms pointer. |
| `compliance()` | Active `ICompliance` policy address. |
| `complianceCodehash()` | Runtime-code hash presently approved for installation. It can differ from the active policy after approval changes and before installation. |
| `POLICY_AUTHORITY()` | Immutable address authorized to approve and install policy code. |
| `ISSUANCE_AUTHORITY()` | Immutable address authorized to manage mint allowances. |
| `mintAllowance(issuer, recipient)` | Amount the named issuer may still mint directly to the named recipient. |
| `mintEnabled()` | `true` until irreversible mint finalization. |
| `burnEnabled()` | Current reversible burn-switch state. |
| `unpauseAvailableAt()` | Earliest timestamp at which the admin may unpause. Zero when no scheduled timestamp is stored. |
| `lockedBalanceOf(holder)` | Nominal active locked amount, or zero after expiry. |
| `availableBalanceOf(holder)` | Transferable balance after the active reserve, saturating at zero. |

Project-specific mutations:

| API | Caller and behavior |
|---|---|
| `setMintAllowance(issuer, recipient, expectedCurrent, amount)` | `issuanceAuthority`; sets the remaining recipient-bound allowance only if the on-chain value equals `expectedCurrent`. This compare-and-set rule prevents an issuer from spending the old allowance immediately before a reduction and then receiving the full replacement allowance. |
| `mint(address recipient, uint256 amount)` | `ISSUER_ROLE`; mints directly to `recipient` and atomically consumes that issuer-recipient allowance. Subject to pause, policy, and `mintEnabled`. |
| `finalizeMinting()` | Default admin; irreversibly sets `mintEnabled` to false. |
| `burn(uint256 amount)` | `BURNER_ROLE`; destroys only the caller's balance. Subject to pause, policy, lock-up, and `burnEnabled`. |
| `setBurnEnabled(bool enabled)` | Default admin; reversibly enables or disables burning. |
| `pause()` | `PAUSER_ROLE`; pauses balance updates and schedules unpause for one hour after this call. |
| `unpause()` | Default admin; succeeds only after `unpauseAvailableAt`. |
| `setTermsUri(string termsUri_)` | Default admin while paused; requires a non-empty value and restarts the cooldown. |
| `setComplianceCodehash(bytes32 codehash)` | `policyAuthority` while paused; approves a non-zero runtime codehash and restarts the cooldown. It does not install or inspect a policy address. |
| `setCompliance(address policy)` | `policyAuthority` while paused; installs an address only when its runtime codehash equals `complianceCodehash`, then restarts the cooldown. |
| `setLockup(address holder, uint256 amount, uint64 releaseAt)` | Default admin; creates or strengthens an aggregate lock during normal operation. Weakening or clearing an active lock requires pause and restarts the cooldown. |

Relevant inherited APIs include the standard ERC-20 surface (`name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `transfer`, `allowance`, `approve`, and `transferFrom`), ERC-2612 permit (`permit`, `nonces`, and `DOMAIN_SEPARATOR`), EIP-5267 domain reporting (`eip712Domain`), pause status (`paused`), and ERC-165 support.

Both production contracts also expose the inherited access-control API:

| API | Purpose |
|---|---|
| `hasRole(role, account)` / `getRoleAdmin(role)` | Query role membership and the role authorized to administer it. |
| `grantRole(role, account)` / `revokeRole(role, account)` | Administer non-default roles. Default admin cannot be copied this way. |
| `renounceRole(role, callerConfirmation)` | Let the confirmed caller drop one of its own non-default roles; default-admin renunciation follows the scheduled rules. |
| `owner()` / `defaultAdmin()` | Return the current default admin. |
| `pendingDefaultAdmin()` | Return the proposed default admin and acceptance schedule. |
| `defaultAdminDelay()` / `pendingDefaultAdminDelay()` | Query the active delay and any scheduled delay change. |
| `defaultAdminDelayIncreaseWait()` | Query the maximum scheduling wait applied to a delay increase. |
| `beginDefaultAdminTransfer(newAdmin)` | Current default admin schedules a transfer. |
| `cancelDefaultAdminTransfer()` | Current default admin cancels a pending transfer. |
| `acceptDefaultAdminTransfer()` | Scheduled recipient accepts after the delay. |
| `changeDefaultAdminDelay(newDelay)` / `rollbackDefaultAdminDelay()` | Schedule or cancel a change to the admin-transfer delay. |

### Supply and redemption

The token has no fixed global supply ceiling because the eventual number of sold warrants is not known at deployment. Supply can grow while `mintEnabled` remains true, but `ISSUER_ROLE` alone is insufficient to mint.

Before each issuance, `ISSUANCE_AUTHORITY` approves a remaining amount for one exact `issuer → recipient` pair. The issuer can mint only that amount and only to that recipient; each successful mint consumes the allowance. A failed mint, including a policy or pause refusal, rolls the allowance change back with the rest of the transaction. Direct issuance to the approved recipient avoids holding newly issued units in the issuer account.

Allowance updates use compare-and-set semantics. `expectedCurrent` must equal the value observed on-chain, otherwise `MintAllowanceChanged(current)` reverts. Operational systems must read the current value immediately before signing an update and review the emitted previous and new values. Setting the new amount to zero cancels unspent authorization. The default admin may permanently close all future issuance with `finalizeMinting`.

Burning is a redemption step rather than a holder right. A holder returns units through an ordinary screened transfer; an account holding `BURNER_ROLE` then burns only the units in its own balance. There is no `burnFrom`, forced burn, clawback, or forced transfer.

`burnEnabled` is intentionally reversible and independent of mint finalization. Disabling it prevents retirement of returned supply without blocking transfers.

### Pause and maintenance cooldown

Pausing stops transfer, `transferFrom`, mint, and burn through `ERC20Pausable`. It does not revoke allowances, invalidate permit signatures, or block approval and permit submission. Any eventual balance movement still passes the current policy and lock-up checks.

Every successful `pause`, `setTermsUri`, `setComplianceCodehash`, `setCompliance`, and active-lock weakening call writes:

```text
unpauseAvailableAt = block.timestamp + 1 hour
```

The default admin must wait until the latest scheduled timestamp before unpausing. A later sensitive action while paused moves the timestamp forward again.

### Approved policy-code lifecycle

The approved codehash is a deployment and operations control, not an on-chain correctness oracle.

Initial deployment requires an instance of the bundled `Compliance` runtime. For a subsequent policy change:

1. compile and review the candidate under the intended compiler settings;
2. obtain its deployed runtime bytecode and codehash;
3. pause the token;
4. have `policyAuthority` call `setComplianceCodehash(candidateHash)` if the approved runtime is changing;
5. have `policyAuthority` call `setCompliance(candidateAddress)`;
6. verify the events, stored address, stored hash, and candidate runtime code;
7. wait until the latest `unpauseAvailableAt`; and
8. have the default admin call `unpause()`.

Changing only `complianceCodehash` does not replace `compliance`; changing only `compliance` is possible only when its runtime already matches the approved hash. The currently active policy is not called during either maintenance operation, so a reverting active policy cannot block its own replacement.

`policyAuthority` may approve any non-zero hash while paused. Review, change approval, and multisig signer policy are therefore essential controls. The token default admin cannot perform this change. Do not approve proxy or mutable-dispatcher bytecode as though its outer codehash fixed its implementation.

### Aggregate lock-ups

Each holder has one aggregate `Lockup { amount, releaseAt }`.

- During normal operation, an active lock may increase in amount, extend in time, or do both; it cannot weaken.
- During a pause, the default admin may reduce, shorten, or clear an active lock. This recovery action restarts the unpause cooldown so it is observable before balances can move again.
- After expiry, `lockedBalanceOf` reports zero and the admin may clear or replace the stored record.
- `amount` may exceed the current balance. This supports locking an allocation before it arrives; `availableBalanceOf` then returns zero.
- Receipt is allowed. Transfers, allowance transfers, and burns may not reduce the holder below the active reserve.

This is not a multi-tranche vesting schedule. Independent grants with different release dates require a different storage model.

### Token events and errors

Operationally important token events are:

| Event | Meaning |
|---|---|
| `MintAllowanceUpdated(issuer, recipient, previousAllowance, newAllowance)` | The remaining recipient-bound amount changed, either through an authority update or a successful mint. |
| `ComplianceCodehashUpdated(previousCodehash, newCodehash)` | Approved runtime family changed. |
| `ComplianceUpdated(previousCompliance, newCompliance)` | Active policy address changed. |
| `UnpauseScheduled(availableAt)` | A pause or maintenance action set a new cooldown deadline. |
| `TermsUriChanged(previousTermsUri, newTermsUri)` | Governing-terms pointer changed. |
| `MintingFinalized()` | Issuance closed permanently. |
| `BurnEnabledUpdated(enabled)` | Burn switch changed. |
| `LockupSet(holder, amount, releaseAt)` | Aggregate holder lock was created, strengthened, replaced after expiry, or cleared. |

Standard inherited events include `Transfer`, `Approval`, `Paused`, `Unpaused`, role grant/revoke events, and the default-admin transfer and delay scheduling events.

The custom token errors distinguish invalid construction data, unauthorized issuance or policy governance, stale or insufficient mint allowances, invalid policy/hash configuration, closed issuance, disabled burning, invalid or weakened lock-ups, a lock-caused shortfall, transfer to the token itself, and an unexpired cooldown. Standard OpenZeppelin errors still report ERC-20 balance/allowance failures, unauthorized roles, pause state, permit failures, and default-admin-rule violations.

## Compliance

### Constructor and admin model

```solidity
constructor(address admin)
```

The address becomes the initial default admin through `AccessControlDefaultAdminRules` with a one-hour default-admin transfer delay. OpenZeppelin validates the address. The sanctions epoch starts at `1`, leaving mapping value `0` as the inactive sentinel.

### Compliance roles

| Role | Authority |
|---|---|
| `DEFAULT_ADMIN_ROLE` | All policy mutations, non-default role administration, and delayed transfer of default admin. |
| `COMPLIANCE_ROLE` | Global and per-token blocks/freezes; add, remove, replace, and reset sanctions. |
| `opsRole(token)` | Derived role for exactly one non-zero token; may impose blocks and set or extend freezes only for that token. It cannot lift restrictions, act globally, or administer sanctions. |

There is no single global `OPS_ROLE`. For token address `token`, derive and grant the role as follows:

```solidity
bytes32 role = compliance.opsRole(token);
compliance.grantRole(role, operator);
```

`opsRole(address(0))` reverts. A token-scoped operator also cannot pass `address(0)` to `setBlocked` or `setFreeze`; global scope requires the default admin or `COMPLIANCE_ROLE`.

### Compliance API

| API | Caller and behavior |
|---|---|
| `checkTransfer(token, operator, from, to, value)` | Public view policy entrypoint. Reverts on the first refused distinct non-zero participant. The bundled policy does not currently use `value`. |
| `checkIsCompliant(token, user)` | Public view single-address check that reverts with the refusal reason. |
| `isCompliant(token, user)` | Non-reverting boolean form of the single-address check. |
| `isSanctioned(user)` | Reports whether `user` belongs to the current sanctions epoch. |
| `sanctionEpoch()` | Returns the active epoch. |
| `blockedAddresses(token, user)` | Public block mapping; `token == address(0)` is global scope. |
| `frozenUntil(token, user)` | Public freeze-expiry mapping; `token == address(0)` is global scope. |
| `opsRole(token)` | Derives the role for a non-zero token address. |
| `MAX_BATCH_SIZE()` | Maximum number of addresses in one array mutation: 200. |
| `setBlocked(token, accounts, blocked)` | A token-scoped operator may pass `blocked == true` only for its token. Compliance officers and the default admin may impose or lift token/global blocks. |
| `setFreeze(token, account, until)` | A token-scoped operator may set or extend a future freeze for its token. Only compliance officers/default admin may shorten, clear, or act globally. |
| `addSanctions(accounts)` | Compliance officer or default admin; adds accounts to the current epoch. |
| `removeSanctions(accounts)` | Compliance officer or default admin; clears named accounts. |
| `resetSanctions()` | Compliance officer or default admin; increments the epoch and invalidates the entire previous list in constant storage work. |
| `setSanctions(accounts)` | Compliance officer or default admin; increments the epoch and atomically writes a non-empty replacement of at most 200 entries. |

All address-array mutations require between 1 and 200 entries and reject `address(0)` as an account. Duplicates are harmless but waste gas.

`setSanctions` provides an atomic replacement only up to the batch limit. A larger live list may be built with several `addSanctions` calls, but intermediate states are immediately effective. If an issuance requires atomic activation of a larger snapshot, it needs a staged inactive epoch design rather than a partially published runbook.

### Refusal precedence

For each participant, the bundled policy evaluates:

1. the token-specific block or global block;
2. membership in the current global sanctions epoch; and
3. the later of the token-specific and global freeze expiry.

It reverts with `UserBlocked(user)`, `UserSanctioned(user)`, or `UserFrozen(user, until)`. The boolean `isCompliant` applies the same conditions without exposing a reason.

### Compliance events and errors

| Event | Meaning |
|---|---|
| `BlocklistUpdated(token, accounts, blocked)` | Token-specific or global block state changed. |
| `FreezeSet(token, account, until)` | Token-specific or global freeze was set or cleared. |
| `SanctionsAdded(epoch, accounts)` | Accounts were added to the named active epoch. |
| `SanctionsRemoved(epoch, accounts)` | An idempotent removal request was applied against the named current epoch; an account may already have been inactive. |
| `SanctionsReset(epoch)` | A fresh epoch became active. `setSanctions` emits this before `SanctionsAdded`. |

Input failures use `EmptyAccounts`, `BatchTooLarge`, `ZeroAddress`, and `FreezeInPast`. Authorization failure uses `UnauthorizedComplianceOperator(account)`. Runtime refusals use the three typed user errors above. Inherited AccessControl errors and default-admin scheduling events/errors remain part of the ABI.

## Default-admin transfer

Both contracts independently use OpenZeppelin `AccessControlDefaultAdminRules` with an initial one-hour transfer delay. `DEFAULT_ADMIN_ROLE` cannot be copied with an ordinary `grantRole` call.

A normal transfer is:

1. the current default admin calls `beginDefaultAdminTransfer(newAdmin)`;
2. observers verify `pendingDefaultAdmin()` and its acceptance schedule;
3. after the schedule matures, `newAdmin` calls `acceptDefaultAdminTransfer()`; and
4. observers verify `defaultAdmin()` and role assignments.

The current admin may cancel a pending transfer before acceptance. Delay changes use their own schedule and rollback functions. Renouncing the last default admin is also a deliberate delayed process; it must not be used accidentally.

The token default admin, `policyAuthority`, and `issuanceAuthority` are separate initial authorities. Both authority addresses are immutable, so use stable multisig addresses and rotate signers inside those multisigs. Transferring the default admin of `Compliance` does not change the token's `policyAuthority`; keep those governance paths aligned through the deployment and operations runbook.

## Deployment sequence

1. Install the exact dependency graph with `npm ci` under the declared Node.js and npm versions.
2. Compile all contracts with the checked-in Hardhat settings.
3. Select a stable compliance multisig as `policyAuthority`, distinct from the token admin, and deploy `Compliance(policyAuthority)`.
4. Verify the deployed policy runtime codehash against the `Compliance` artifact.
5. Select a separate stable issuance multisig as `issuanceAuthority`.
6. Deploy `PipoSecurityToken(name, symbol, identifier, termsUri, tokenAdmin, issuer, burner, pauser, policyAuthority, issuanceAuthority, complianceAddress)`.
7. Verify token metadata, both immutable authorities, `compliance`, `complianceCodehash`, distinct initial role holders, default-admin delay, mint/burn switches, zero initial supply, and zero initial mint allowances.
8. Grant `COMPLIANCE_ROLE` only to approved global-policy actors.
9. For each token-specific operations actor, compute `opsRole(tokenAddress)` and grant only that derived role.
10. Configure initial blocks, sanctions, freezes, and holder lock-ups before distribution where required.
11. Approve and mint each confirmed issuance directly to its recipient as described below.
12. Transfer each default-admin role to its production multisig through the delayed two-step process if the deployment account is temporary. This does not rotate either immutable authority.

Record contract addresses, chain ID, creation transactions, runtime codehashes, compiler inputs, role assignments, admin schedules, and governing terms outside the chain as release evidence.

## Operations runbooks

### Pause and resume

1. A pauser calls `pause` and records `unpauseAvailableAt`.
2. Stop distribution and investigate. Allowances and permits remain present but cannot move balances while paused.
3. Apply approved terms, policy, or lock-recovery maintenance through the responsible authority; each sensitive action restarts the cooldown.
4. Verify the final state and latest deadline.
5. After the deadline, the token default admin calls `unpause`.

### Recover from a reverting policy

1. Pause the token; pausing does not call the policy.
2. Deploy and verify a reviewed replacement.
3. If its runtime differs from the approved hash, have `policyAuthority` approve the new hash with `setComplianceCodehash`.
4. Have `policyAuthority` install it with `setCompliance`.
5. Execute read-only policy checks and verify stored code/address values.
6. Wait for the latest cooldown and unpause through the default admin.

### Update governing terms

1. Publish and independently verify the new document.
2. Pause the token.
3. Call `setTermsUri` and capture `TermsUriChanged` and `UnpauseScheduled`.
4. Verify the stored reference, wait for the cooldown, and unpause.

### Manage blocks and freezes

- A token operator uses only its assigned token address and may only impose a block or set/extend a freeze.
- A compliance officer or default admin lifts or shortens restrictions and uses `address(0)` only when an action must apply to every token sharing the policy.
- Send sensitive restrictions through a private transaction path where available, or pause before publishing them, so the target cannot front-run the restriction in the public mempool.
- Use `until == 0` to lift a freeze. Do not use a past non-zero timestamp.
- Verify emitted token scope and named accounts before treating an operation as complete.

### Replace sanctions

- For an atomic list of at most 200 addresses, call `setSanctions` once and verify both epoch events.
- To clear every sanction, call the explicit `resetSanctions`; an empty `setSanctions` is rejected.
- Use `addSanctions` and `removeSanctions` for incremental changes within the active epoch.
- Do not represent a larger atomic snapshot as several live transactions. Intermediate batches are enforceable immediately and therefore expose a partial-list interval.

### Manage a holder lock-up

1. Confirm the holder, nominal amount, release timestamp, and whether an active lock already exists.
2. For an ordinary active-lock update, ensure neither amount nor duration decreases.
3. To correct, shorten, or clear an active lock, pause first; the change will restart the unpause cooldown.
4. Call `setLockup` and verify `LockupSet`, `lockedBalanceOf`, `availableBalanceOf`, and, for recovery, `unpauseAvailableAt`.

### Authorize and execute issuance

1. Complete the off-chain subscription, payment, legal, and eligibility checks for the exact recipient and amount.
2. Confirm that the chosen issuer still holds `ISSUER_ROLE`, the recipient is compliant, and the token is not paused.
3. Read `mintAllowance(issuer, recipient)` from the intended chain and contract.
4. Have `issuanceAuthority` call `setMintAllowance(issuer, recipient, expectedCurrent, amount)`, using the observed current value. Prefer the exact amount for the pending issuance rather than a standing buffer.
5. Verify `MintAllowanceUpdated`, then have the named issuer call `mint(recipient, amount)`.
6. Verify the recipient balance, `totalSupply`, the `Transfer` event from the zero address, and the remaining allowance. For an exact one-shot allowance, the remainder must be zero.

If an issuance is cancelled, set the remaining allowance to zero using its current on-chain value. When reducing an allowance against an untrusted or compromised issuer, use a private transaction path or pause and revoke `ISSUER_ROLE`; compare-and-set prevents a stale update from silently reauthorizing value after a concurrent mint. Before later re-granting an issuer role, verify and cancel every known unused allowance for that address.

### Finalize issuance

1. Reconcile all mint transactions, total supply, recipient allocations, and outstanding mint allowances; cancel every remaining allowance.
2. Obtain the required irreversible-action approval.
3. Have the token default admin call `finalizeMinting`.
4. Verify `MintingFinalized`, `mintEnabled == false`, and that later mint attempts fail.

## Security assumptions and residual boundaries

- Default admins, `policyAuthority`, `issuanceAuthority`, compliance officers, issuers, burners, and pausers are trusted operational actors. Use multisigs and least-privilege assignments.
- The one-hour default-admin delay protects admin succession, not ordinary actions by the current admin. Policy approval and installation belong instead to immutable `policyAuthority`, which the token admin cannot grant to itself.
- The unpause cooldown provides an observation window but is not a timelock on every privileged operation. Terms and approved-policy state change immediately while paused.
- Runtime codehash equality proves byte identity only. It does not prove correct policy state, honest behavior, suitable configuration, or immutable downstream dependencies. A proxy can keep the same outer code while changing delegated logic.
- The policy is fail-closed for balance updates. A revert, excessive gas use, or unavailable policy stops transfer, mint, and burn until maintenance replaces it.
- Unknown addresses are permitted by the bundled negative-list policy. An issuance requiring an on-chain allowlist needs a different reviewed policy.
- There is deliberately no global supply cap. `issuanceAuthority` can authorize unlimited cumulative issuance and is therefore a critical multisig. A compromised issuer cannot choose a recipient or amount beyond its active recipient-bound allowances, but it can consume those allowances earlier than intended.
- The token admin can grant `ISSUER_ROLE` but cannot create a mint allowance. Revoking that role stops minting but does not erase stored allowances; cancel unused allowances before the issuer is ever re-granted.
- Issuer and burner are distinct at deployment. The token admin can later change ordinary role membership and must preserve segregation operationally.
- There is no forced transfer, forced burn, clawback, key-loss recovery, or administrative seizure.
- Minting sends supply directly to the allowance's approved recipient. Contract recipients may be unable to move their balance; review recipient capability before authorizing issuance.
- Lock-ups are a single aggregate reserve, not independent vesting tranches. A future honest admin can recover an erroneous or hostile lock only through paused maintenance and the cooldown.
- Pause does not invalidate approvals or permit signatures.
- Freeze, lock expiry, cooldown, and admin schedules rely on `block.timestamp` and inherit normal boundary-time validator influence.
- The sanctions batch cap bounds a single transaction but does not provide staged activation for snapshots larger than 200 entries.
- `termsUri` is only checked for non-emptiness. Content addressing, document validity, and archival guarantees are off-chain responsibilities.
- Compiler version, EVM target, `viaIR`, optimizer configuration, linked source, and metadata affect runtime bytecode. Reproduce the checked-in build settings before approving a policy hash.

## Build and test

The package declares its supported Node.js version and npm package manager in `package.json`. Install with the committed lockfile:

```bash
npm ci
```

Run the verification commands:

```bash
npm run compile
npm run lint
npm run typecheck
npm test
npm run coverage
npm run test:gas
npm audit --omit=dev
npm audit
```

The Solidity build uses compiler `0.8.36`, Cancun EVM semantics, `viaIR`, and optimizer runs set to 200. The local Hardhat network enforces the normal EIP-170 deployed-code-size limit. No live network or account configuration is included.

Generated artifacts, cache, coverage output, and TypeChain bindings are intentionally ignored by Git. Rebuild them from the committed sources and lockfile rather than treating local generated output as release evidence.
