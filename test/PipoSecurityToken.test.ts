import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Compliance, MockCompliance, PipoSecurityToken } from "../typechain-types";

describe("PipoSecurityToken", function () {
  const NAME = "Example Participation Certificate";
  const SYMBOL = "XCFP";
  const IDENTIFIER = "KYG1234A5678";
  const TERMS = "ipfs://bafy/terms-v1.pdf";

  async function deployFixture() {
    const [
      deployer,
      admin,
      policyAuthority,
      issuanceAuthority,
      issuer,
      burner,
      pauser,
      holder,
      spender,
      outsider,
    ] = await ethers.getSigners();
    const policy = (await ethers.deployContract("Compliance", [policyAuthority.address])) as unknown as Compliance;
    const token = (await ethers.deployContract("PipoSecurityToken", [
      NAME,
      SYMBOL,
      IDENTIFIER,
      TERMS,
      admin.address,
      issuer.address,
      burner.address,
      pauser.address,
      policyAuthority.address,
      issuanceAuthority.address,
      await policy.getAddress(),
    ])) as unknown as PipoSecurityToken;
    return {
      deployer,
      admin,
      policyAuthority,
      issuanceAuthority,
      issuer,
      burner,
      pauser,
      holder,
      spender,
      outsider,
      policy,
      token,
    };
  }

  async function deployToken(overrides: Partial<{
    name: string;
    symbol: string;
    identifier: string;
    terms: string;
    admin: string;
    issuer: string;
    burner: string;
    pauser: string;
    policyAuthority: string;
    issuanceAuthority: string;
    policy: string;
  }> = {}) {
    const [, admin, policyAuthority, issuanceAuthority, issuer, burner, pauser] =
      await ethers.getSigners();
    const authority = overrides.policyAuthority ?? policyAuthority.address;
    const policy = await ethers.deployContract("Compliance", [authority]);
    return ethers.deployContract("PipoSecurityToken", [
      overrides.name ?? NAME,
      overrides.symbol ?? SYMBOL,
      overrides.identifier ?? IDENTIFIER,
      overrides.terms ?? TERMS,
      overrides.admin ?? admin.address,
      overrides.issuer ?? issuer.address,
      overrides.burner ?? burner.address,
      overrides.pauser ?? pauser.address,
      authority,
      overrides.issuanceAuthority ?? issuanceAuthority.address,
      overrides.policy ?? await policy.getAddress(),
    ]);
  }

  async function authorizeAndMint(
    token: PipoSecurityToken,
    issuanceAuthority: Awaited<ReturnType<typeof ethers.getSigners>>[number],
    issuer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
    recipient: string,
    amount: bigint,
  ) {
    const current = await token.mintAllowance(issuer.address, recipient);
    await token.connect(issuanceAuthority).setMintAllowance(issuer.address, recipient, current, amount);
    await token.connect(issuer).mint(recipient, amount);
  }

  describe("construction and authority", function () {
    it("binds immutable metadata and the initial compliance codehash", async function () {
      const { token, policy, admin, policyAuthority, issuanceAuthority, issuer, burner, pauser, outsider } =
        await deployFixture();

      expect(await token.name()).to.equal(NAME);
      expect(await token.symbol()).to.equal(SYMBOL);
      expect(await token.identifier()).to.equal(IDENTIFIER);
      expect(await token.termsUri()).to.equal(TERMS);
      expect(await token.decimals()).to.equal(18);
      expect(await token.totalSupply()).to.equal(0);
      expect(await token.mintEnabled()).to.equal(true);
      expect(await token.burnEnabled()).to.equal(true);
      expect(await token.compliance()).to.equal(await policy.getAddress());
      expect(await token.POLICY_AUTHORITY()).to.equal(policyAuthority.address);
      expect(await token.ISSUANCE_AUTHORITY()).to.equal(issuanceAuthority.address);
      expect(await policy.defaultAdmin()).to.equal(policyAuthority.address);
      expect(await token.complianceCodehash()).to.equal(
        ethers.keccak256(await ethers.provider.getCode(await policy.getAddress())),
      );
      expect(await token.defaultAdmin()).to.equal(admin.address);
      expect(await token.defaultAdminDelay()).to.equal(3600);

      const adminRole = await token.DEFAULT_ADMIN_ROLE();
      const issuerRole = await token.ISSUER_ROLE();
      const burnerRole = await token.BURNER_ROLE();
      const pauserRole = await token.PAUSER_ROLE();
      expect(await token.hasRole(adminRole, admin.address)).to.equal(true);
      expect(await token.hasRole(issuerRole, issuer.address)).to.equal(true);
      expect(await token.hasRole(burnerRole, burner.address)).to.equal(true);
      expect(await token.hasRole(burnerRole, issuer.address)).to.equal(false);
      expect(await token.hasRole(pauserRole, pauser.address)).to.equal(true);
      for (const role of [adminRole, issuerRole, burnerRole, pauserRole]) {
        expect(await token.hasRole(role, outsider.address)).to.equal(false);
      }
    });

    it("rejects empty metadata and zero authorities", async function () {
      await expect(deployToken({ name: "" })).to.be.revertedWithCustomError(
        await ethers.getContractFactory("PipoSecurityToken"),
        "EmptyName",
      );
      await expect(deployToken({ symbol: "" })).to.be.revertedWithCustomError(
        await ethers.getContractFactory("PipoSecurityToken"),
        "EmptySymbol",
      );
      await expect(deployToken({ identifier: "" })).to.be.revertedWithCustomError(
        await ethers.getContractFactory("PipoSecurityToken"),
        "EmptyIdentifier",
      );
      await expect(deployToken({ terms: "" })).to.be.revertedWithCustomError(
        await ethers.getContractFactory("PipoSecurityToken"),
        "EmptyTermsUri",
      );
      for (const key of [
        "admin",
        "issuer",
        "burner",
        "pauser",
        "policyAuthority",
        "issuanceAuthority",
      ] as const) {
        await expect(deployToken({ [key]: ethers.ZeroAddress })).to.be.reverted;
      }
      const [, admin, policyAuthority, , issuer, burner, pauser] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("PipoSecurityToken");
      for (const [overrides, error] of [
        [{ issuer: admin.address }, "InvalidIssuer"],
        [{ burner: admin.address }, "InvalidBurner"],
        [{ burner: issuer.address }, "InvalidBurner"],
        [{ pauser: admin.address }, "InvalidPauser"],
        [{ pauser: issuer.address }, "InvalidPauser"],
        [{ pauser: burner.address }, "InvalidPauser"],
        [{ policyAuthority: admin.address }, "InvalidPolicyAuthority"],
        [{ policyAuthority: issuer.address }, "InvalidPolicyAuthority"],
        [{ policyAuthority: burner.address }, "InvalidPolicyAuthority"],
        [{ policyAuthority: pauser.address }, "InvalidPolicyAuthority"],
        [{ issuanceAuthority: admin.address }, "InvalidIssuanceAuthority"],
        [{ issuanceAuthority: issuer.address }, "InvalidIssuanceAuthority"],
        [{ issuanceAuthority: burner.address }, "InvalidIssuanceAuthority"],
        [{ issuanceAuthority: pauser.address }, "InvalidIssuanceAuthority"],
        [{ issuanceAuthority: policyAuthority.address }, "InvalidIssuanceAuthority"],
      ] as const) {
        await expect(deployToken(overrides)).to.be.revertedWithCustomError(factory, error);
      }
    });

    it("rejects every initial policy except the bundled Compliance runtime", async function () {
      const factory = await ethers.getContractFactory("PipoSecurityToken");
      const legacy = await ethers.deployContract("LegacySelectorFallbackPolicy");
      const alternate = await ethers.deployContract("MockCompliance", [(await ethers.getSigners())[2].address]);
      const mismatchedAuthority = await ethers.deployContract("Compliance", [
        (await ethers.getSigners())[8].address,
      ]);

      for (const policy of [
        ethers.ZeroAddress,
        (await ethers.getSigners())[1].address,
        await legacy.getAddress(),
        await alternate.getAddress(),
      ]) {
        await expect(deployToken({ policy })).to.be.revertedWithCustomError(factory, "InvalidCompliance");
      }
      await expect(deployToken({ policy: await mismatchedAuthority.getAddress() }))
        .to.be.revertedWithCustomError(factory, "InvalidPolicyAuthority");
    });

    it("uses delayed two-step default-admin rules", async function () {
      const { token, admin, outsider } = await deployFixture();
      const adminRole = await token.DEFAULT_ADMIN_ROLE();
      await expect(token.connect(admin).grantRole(adminRole, outsider.address))
        .to.be.revertedWithCustomError(token, "AccessControlEnforcedDefaultAdminRules");

      await token.connect(admin).beginDefaultAdminTransfer(outsider.address);
      await expect(token.connect(outsider).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(token, "AccessControlEnforcedDefaultAdminDelay");
      const [, schedule] = await token.pendingDefaultAdmin();
      await time.increaseTo(schedule);
      await token.connect(outsider).acceptDefaultAdminTransfer();
      expect(await token.defaultAdmin()).to.equal(outsider.address);
    });

    it("cannot schedule loss of the default admin", async function () {
      const { token, admin } = await deployFixture();
      await expect(token.connect(admin).beginDefaultAdminTransfer(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "InvalidDefaultAdmin");
    });

    it("does not expose mutable metadata or a reversible mint switch", async function () {
      const artifact = await artifacts.readArtifact("PipoSecurityToken");
      const names = artifact.abi
        .filter((entry) => entry.type === "function" && "name" in entry)
        .map((entry) => "name" in entry ? entry.name : "");
      for (const absent of ["setName", "setSymbol", "setIdentifier", "setMintEnabled"]) {
        expect(names).not.to.include(absent);
      }
    });
  });

  describe("issuance and retirement", function () {
    it("requires an independent recipient-bound allowance for every mint", async function () {
      const { token, issuanceAuthority, issuer, holder, outsider } = await deployFixture();
      await expect(token.connect(holder).mint(holder.address, 1)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await expect(token.connect(issuer).mint(holder.address, 1))
        .to.be.revertedWithCustomError(token, "MintAllowanceExceeded")
        .withArgs(0);
      await expect(
        token.connect(outsider).setMintAllowance(issuer.address, holder.address, 0, 10),
      )
        .to.be.revertedWithCustomError(token, "UnauthorizedIssuanceAuthority")
        .withArgs(outsider.address);

      await expect(
        token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 10),
      )
        .to.emit(token, "MintAllowanceUpdated")
        .withArgs(issuer.address, holder.address, 0, 10);
      await expect(token.connect(issuer).mint(holder.address, 6))
        .to.emit(token, "MintAllowanceUpdated")
        .withArgs(issuer.address, holder.address, 10, 4);
      expect(await token.balanceOf(holder.address)).to.equal(6);
      expect(await token.balanceOf(issuer.address)).to.equal(0);
      expect(await token.mintAllowance(issuer.address, holder.address)).to.equal(4);
      await expect(token.connect(issuer).mint(holder.address, 5))
        .to.be.revertedWithCustomError(token, "MintAllowanceExceeded")
        .withArgs(4);
    });

    it("updates allowances race-safely and cannot redirect them", async function () {
      const { token, issuanceAuthority, issuer, holder, outsider } = await deployFixture();
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 10);
      await token.connect(issuer).mint(holder.address, 4);

      await expect(
        token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 10, 2),
      )
        .to.be.revertedWithCustomError(token, "MintAllowanceChanged")
        .withArgs(6);
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 6, 2);
      await expect(token.connect(issuer).mint(outsider.address, 1))
        .to.be.revertedWithCustomError(token, "MintAllowanceExceeded")
        .withArgs(0);
      await token.connect(issuer).mint(holder.address, 2);
      expect(await token.totalSupply()).to.equal(6);
      expect(await token.mintAllowance(issuer.address, holder.address)).to.equal(0);
    });

    it("rejects invalid allowance targets and rolls consumption back on a failed mint", async function () {
      const { token, policy, policyAuthority, issuanceAuthority, issuer, holder, outsider } =
        await deployFixture();
      for (const recipient of [ethers.ZeroAddress, await token.getAddress()]) {
        await expect(
          token.connect(issuanceAuthority).setMintAllowance(issuer.address, recipient, 0, 1),
        ).to.be.revertedWithCustomError(token, "InvalidMintRecipient");
      }
      await expect(
        token.connect(issuanceAuthority).setMintAllowance(outsider.address, holder.address, 0, 1),
      ).to.be.revertedWithCustomError(token, "InvalidIssuer");

      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 3);
      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [holder.address], true);
      await expect(token.connect(issuer).mint(holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(holder.address);
      expect(await token.mintAllowance(issuer.address, holder.address)).to.equal(3);
    });

    it("finalizes minting irreversibly", async function () {
      const { token, admin, issuanceAuthority, issuer, holder } = await deployFixture();
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 1);
      await expect(token.connect(holder).finalizeMinting()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await expect(token.connect(admin).finalizeMinting()).to.emit(token, "MintingFinalized");
      expect(await token.mintEnabled()).to.equal(false);
      await expect(token.connect(issuer).mint(holder.address, 1))
        .to.be.revertedWithCustomError(token, "MintDisabled");
      await expect(token.connect(admin).finalizeMinting()).to.be.revertedWithCustomError(
        token,
        "MintingAlreadyFinalized",
      );
    });

    it("separates burn authority from mint authority", async function () {
      const { token, admin, issuanceAuthority, issuer, holder, burner } = await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 10n);
      await token.connect(issuer).transfer(burner.address, 4);

      await expect(token.connect(holder).burn(1)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await expect(token.connect(admin).burn(1)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );

      await token.connect(burner).burn(4);
      expect(await token.balanceOf(burner.address)).to.equal(0);
      expect(await token.totalSupply()).to.equal(6);
      expect(await token.hasRole(await token.ISSUER_ROLE(), burner.address)).to.equal(false);
    });

    it("keeps the burn switch reversible and admin-controlled", async function () {
      const { token, admin, issuanceAuthority, issuer, burner, holder } = await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 3n);
      await token.connect(issuer).transfer(burner.address, 1);
      await expect(token.connect(holder).setBurnEnabled(false)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await expect(token.connect(admin).setBurnEnabled(false))
        .to.emit(token, "BurnEnabledUpdated")
        .withArgs(false);
      await expect(token.connect(burner).burn(1)).to.be.revertedWithCustomError(token, "BurnDisabled");
      await token.connect(admin).setBurnEnabled(true);
      await token.connect(burner).burn(1);
    });
  });

  describe("pause, terms and compliance maintenance", function () {
    it("lets the guardian pause, but only the admin unpause", async function () {
      const { token, admin, pauser, holder } = await deployFixture();
      await expect(token.connect(holder).pause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await token.connect(pauser).pause();
      await expect(token.connect(pauser).unpause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      const availableAt = await token.unpauseAvailableAt();
      await expect(token.connect(admin).unpause())
        .to.be.revertedWithCustomError(token, "UnpauseCooldown")
        .withArgs(availableAt);
      await time.increaseTo(availableAt);
      await token.connect(admin).unpause();
      expect(await token.paused()).to.equal(false);
    });

    it("pauses transfers, transferFrom, mint and burn", async function () {
      const {
        token,
        policy,
        policyAuthority,
        issuanceAuthority,
        issuer,
        burner,
        pauser,
        holder,
        spender,
      } = await deployFixture();
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, issuer.address, 0, 11);
      await token.connect(issuer).mint(issuer.address, 10);
      await token.connect(issuer).transfer(burner.address, 1);
      await token.connect(issuer).approve(spender.address, 2);
      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [issuer.address], true);
      await token.connect(pauser).pause();

      await expect(token.connect(issuer).transfer(holder.address, 1)).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );
      await expect(token.connect(spender).transferFrom(issuer.address, holder.address, 1))
        .to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(issuer).mint(issuer.address, 1))
        .to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(burner).burn(1)).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("updates terms only while paused and enforces the one-hour cooldown", async function () {
      const { token, admin, pauser, holder } = await deployFixture();
      const nextTerms = "ipfs://bafy/terms-v2.pdf";
      await expect(token.connect(admin).setTermsUri(nextTerms)).to.be.revertedWithCustomError(
        token,
        "ExpectedPause",
      );
      await token.connect(pauser).pause();
      await expect(token.connect(holder).setTermsUri(nextTerms)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
      await expect(token.connect(admin).setTermsUri("")).to.be.revertedWithCustomError(
        token,
        "EmptyTermsUri",
      );
      await expect(token.connect(admin).setTermsUri(nextTerms))
        .to.emit(token, "TermsUriChanged")
        .withArgs(TERMS, nextTerms);
      expect(await token.termsUri()).to.equal(nextTerms);

      const availableAt = await token.unpauseAvailableAt();
      await expect(token.connect(admin).unpause())
        .to.be.revertedWithCustomError(token, "UnpauseCooldown")
        .withArgs(availableAt);
      await time.increaseTo(availableAt);
      await token.connect(admin).unpause();
      expect(await token.unpauseAvailableAt()).to.equal(0);
    });

    it("atomically approves and installs a governed alternate runtime", async function () {
      const { token, policy, admin, policyAuthority, issuanceAuthority, pauser, holder, issuer } =
        await deployFixture();
      const alternate = (await ethers.deployContract("MockCompliance", [
        policyAuthority.address,
      ])) as unknown as MockCompliance;
      const alternateHash = ethers.keccak256(await ethers.provider.getCode(await alternate.getAddress()));

      await expect(token.connect(policyAuthority).setCompliance(await alternate.getAddress(), alternateHash))
        .to.be.revertedWithCustomError(token, "ExpectedPause");
      await token.connect(pauser).pause();
      await expect(token.connect(holder).setCompliance(await alternate.getAddress(), alternateHash))
        .to.be.revertedWithCustomError(token, "UnauthorizedPolicyAuthority")
        .withArgs(holder.address);
      await expect(token.connect(admin).setCompliance(await alternate.getAddress(), alternateHash))
        .to.be.revertedWithCustomError(token, "UnauthorizedPolicyAuthority")
        .withArgs(admin.address);
      await expect(token.connect(policyAuthority).setCompliance(await alternate.getAddress(), ethers.ZeroHash))
        .to.be.revertedWithCustomError(token, "InvalidCompliance");
      const bundledHash = await token.complianceCodehash();
      await expect(token.connect(policyAuthority).setCompliance(await alternate.getAddress(), alternateHash))
        .to.emit(token, "ComplianceCodehashUpdated")
        .withArgs(bundledHash, alternateHash)
        .and.to.emit(token, "ComplianceUpdated")
        .withArgs(await policy.getAddress(), await alternate.getAddress());
      expect(await token.compliance()).to.equal(await alternate.getAddress());
      expect(await token.complianceCodehash()).to.equal(alternateHash);

      await alternate.setRefuseAll(true, "Alternate active");
      await time.increaseTo(await token.unpauseAvailableAt());
      await token.connect(admin).unpause();
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 1);
      await expect(token.connect(issuer).mint(holder.address, 1))
        .to.be.revertedWithCustomError(alternate, "Refused");
    });

    it("never treats an empty-code account as an approved policy", async function () {
      const { token, policyAuthority, pauser, holder } = await deployFixture();
      await token.connect(pauser).pause();
      await expect(
        token.connect(policyAuthority).setCompliance(holder.address, ethers.keccak256("0x")),
      )
        .to.be.revertedWithCustomError(token, "InvalidCompliance");
    });

    it("rejects a codehash-approved contract without policy governance", async function () {
      const { token, policyAuthority, pauser } = await deployFixture();
      const malformed = await ethers.deployContract("LegacySelectorFallbackPolicy");
      const malformedHash = ethers.keccak256(await ethers.provider.getCode(await malformed.getAddress()));
      await token.connect(pauser).pause();
      await expect(token.connect(policyAuthority).setCompliance(await malformed.getAddress(), malformedHash))
        .to.be.revertedWithCustomError(token, "InvalidCompliance");
    });

    it("rejects a no-op policy update instead of extending the cooldown", async function () {
      const { token, policy, policyAuthority, pauser } = await deployFixture();
      await token.connect(pauser).pause();
      const availableAt = await token.unpauseAvailableAt();
      await expect(
        token.connect(policyAuthority).setCompliance(
          await policy.getAddress(),
          await token.complianceCodehash(),
        ),
      ).to.be.revertedWithCustomError(token, "ComplianceUnchanged");
      expect(await token.unpauseAvailableAt()).to.equal(availableAt);
    });

    it("keeps the current policy resumable after a failed atomic replacement", async function () {
      const { token, policy, admin, policyAuthority, pauser } = await deployFixture();
      const alternate = await ethers.deployContract("MockCompliance", [policyAuthority.address]);
      const alternateHash = ethers.keccak256(await ethers.provider.getCode(await alternate.getAddress()));
      const originalHash = await token.complianceCodehash();
      await token.connect(pauser).pause();
      await expect(token.connect(policyAuthority).setCompliance(await alternate.getAddress(), originalHash))
        .to.be.revertedWithCustomError(token, "InvalidCompliance");
      expect(await token.compliance()).to.equal(await policy.getAddress());
      expect(await token.complianceCodehash()).to.equal(originalHash);
      await time.increaseTo(await token.unpauseAvailableAt());
      await token.connect(admin).unpause();
      expect(alternateHash).not.to.equal(originalHash);
    });

    it("rejects a replacement governed by a different authority", async function () {
      const { token, policyAuthority, pauser, outsider } = await deployFixture();
      const replacement = await ethers.deployContract("Compliance", [outsider.address]);
      const replacementHash = ethers.keccak256(
        await ethers.provider.getCode(await replacement.getAddress()),
      );
      await token.connect(pauser).pause();
      await expect(
        token.connect(policyAuthority).setCompliance(await replacement.getAddress(), replacementHash),
      ).to.be.revertedWithCustomError(token, "InvalidPolicyAuthority");
    });

    it("replaces a refusing current policy without consulting it", async function () {
      const { token, policy, admin, policyAuthority, issuanceAuthority, pauser, issuer, holder } =
        await deployFixture();
      const replacement = (await ethers.deployContract("Compliance", [
        policyAuthority.address,
      ])) as unknown as Compliance;
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 1);
      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [issuer.address], true);
      await expect(token.connect(issuer).mint(holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(issuer.address);

      await token.connect(pauser).pause();
      const replacementHash = ethers.keccak256(
        await ethers.provider.getCode(await replacement.getAddress()),
      );
      await expect(
        token.connect(policyAuthority).setCompliance(await replacement.getAddress(), replacementHash),
      )
        .to.emit(token, "ComplianceUpdated")
        .withArgs(await policy.getAddress(), await replacement.getAddress());
      await time.increaseTo(await token.unpauseAvailableAt());
      await token.connect(admin).unpause();
      await token.connect(issuer).mint(holder.address, 1);
    });

    it("restarts the cooldown after each sensitive change", async function () {
      const { token, admin, pauser } = await deployFixture();
      await token.connect(pauser).pause();
      await token.connect(admin).setTermsUri("ipfs://bafy/v2");
      const first = await token.unpauseAvailableAt();
      await time.increase(120);
      await token.connect(admin).setTermsUri("ipfs://bafy/v3");
      expect(await token.unpauseAvailableAt()).to.be.greaterThan(first);
    });
  });

  describe("aggregate lock-ups", function () {
    it("immobilises only the locked reserve and applies to burn", async function () {
      const { token, admin, issuanceAuthority, issuer, burner, holder } = await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 140n);
      await token.connect(issuer).transfer(holder.address, 100);
      await token.connect(issuer).transfer(burner.address, 40);
      const releaseAt = (await time.latest()) + 3600;
      await token.connect(admin).setLockup(holder.address, 60, releaseAt);
      expect(await token.lockedBalanceOf(holder.address)).to.equal(60);
      expect(await token.availableBalanceOf(holder.address)).to.equal(40);
      await token.connect(holder).transfer(issuer.address, 40);
      await expect(token.connect(holder).transfer(issuer.address, 1))
        .to.be.revertedWithCustomError(token, "LockedBalance")
        .withArgs(60);

      await token.connect(admin).setLockup(burner.address, 40, releaseAt);
      await expect(token.connect(burner).burn(1)).to.be.revertedWithCustomError(token, "LockedBalance");
    });

    it("permits pre-locking and never blocks receipt", async function () {
      const { token, admin, issuanceAuthority, issuer, holder } = await deployFixture();
      const releaseAt = (await time.latest()) + 3600;
      await token.connect(admin).setLockup(holder.address, 80, releaseAt);
      expect(await token.availableBalanceOf(holder.address)).to.equal(0);
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 100n);
      await token.connect(issuer).transfer(holder.address, 30);
      expect(await token.availableBalanceOf(holder.address)).to.equal(0);
      await token.connect(issuer).transfer(holder.address, 70);
      expect(await token.availableBalanceOf(holder.address)).to.equal(20);
    });

    it("enforces the locked reserve through transferFrom and rolls allowance back", async function () {
      const { token, admin, issuanceAuthority, issuer, holder, spender } = await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 10n);
      await token.connect(issuer).transfer(holder.address, 10);
      await token.connect(admin).setLockup(holder.address, 8, (await time.latest()) + 3600);
      await token.connect(holder).approve(spender.address, 3);

      await token.connect(spender).transferFrom(holder.address, issuer.address, 2);
      await expect(token.connect(spender).transferFrom(holder.address, issuer.address, 1))
        .to.be.revertedWithCustomError(token, "LockedBalance")
        .withArgs(8);
      expect(await token.allowance(holder.address, spender.address)).to.equal(1);
    });

    it("allows an active aggregate lock only to strengthen", async function () {
      const { token, admin, holder } = await deployFixture();
      const releaseAt = (await time.latest()) + 3600;
      await token.connect(admin).setLockup(holder.address, 60, releaseAt);

      for (const [amount, until] of [
        [59, releaseAt],
        [60, releaseAt - 1],
        [0, 0],
      ]) {
        await expect(token.connect(admin).setLockup(holder.address, amount, until))
          .to.be.revertedWithCustomError(token, "LockupCannotWeaken");
      }

      await token.connect(admin).setLockup(holder.address, 61, releaseAt);
      await token.connect(admin).setLockup(holder.address, 61, releaseAt + 60);
      expect(await token.lockedBalanceOf(holder.address)).to.equal(61);
    });

    it("recovers even an effectively permanent lock through paused maintenance", async function () {
      const { token, admin, pauser, holder } = await deployFixture();
      const maximumTimestamp = (1n << 64n) - 1n;
      await token.connect(admin).setLockup(holder.address, ethers.MaxUint256, maximumTimestamp);

      await expect(token.connect(admin).setLockup(holder.address, 0, 0))
        .to.be.revertedWithCustomError(token, "LockupCannotWeaken");
      await token.connect(pauser).pause();
      await expect(token.connect(admin).setLockup(holder.address, 0, 0))
        .to.emit(token, "LockupSet")
        .withArgs(holder.address, 0, 0);
      expect(await token.lockedBalanceOf(holder.address)).to.equal(0);

      const availableAt = await token.unpauseAvailableAt();
      await expect(token.connect(admin).unpause())
        .to.be.revertedWithCustomError(token, "UnpauseCooldown")
        .withArgs(availableAt);
      await time.increaseTo(availableAt);
      await token.connect(admin).unpause();
    });

    it("clears unpaused only after expiry and can then establish a fresh lock", async function () {
      const { token, admin, holder } = await deployFixture();
      const releaseAt = (await time.latest()) + 60;
      await token.connect(admin).setLockup(holder.address, 10, releaseAt);
      await time.increaseTo(releaseAt);
      expect(await token.lockedBalanceOf(holder.address)).to.equal(0);
      await expect(token.connect(admin).setLockup(holder.address, 0, 123))
        .to.emit(token, "LockupSet")
        .withArgs(holder.address, 0, 0);
      const next = (await time.latest()) + 120;
      await token.connect(admin).setLockup(holder.address, 5, next);
      expect(await token.lockedBalanceOf(holder.address)).to.equal(5);
    });

    it("rejects invalid lock-up inputs and plain balance shortfalls remain ERC20 errors", async function () {
      const { token, admin, issuanceAuthority, issuer, holder } = await deployFixture();
      const future = (await time.latest()) + 60;
      await expect(token.connect(holder).setLockup(holder.address, 1, future))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(admin).setLockup(ethers.ZeroAddress, 1, future))
        .to.be.revertedWithCustomError(token, "InvalidLockupHolder");
      await expect(token.connect(admin).setLockup(holder.address, 1, 1))
        .to.be.revertedWithCustomError(token, "LockupInPast");

      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 1n);
      await expect(token.connect(issuer).transfer(holder.address, 2))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  describe("transfer-aware compliance and permit", function () {
    it("screens endpoints and a distinct transferFrom operator", async function () {
      const { token, policy, policyAuthority, issuanceAuthority, issuer, holder, spender } =
        await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 10n);
      await token.connect(issuer).approve(spender.address, 3);

      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [spender.address], true);
      await expect(token.connect(spender).transferFrom(issuer.address, holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(spender.address);
      expect(await token.allowance(issuer.address, spender.address)).to.equal(3);

      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [spender.address], false);
      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [holder.address], true);
      await expect(token.connect(spender).transferFrom(issuer.address, holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(holder.address);
    });

    it("rejects a refused sender even when the recipient is permitted", async function () {
      const { token, policy, policyAuthority, issuanceAuthority, issuer, burner, holder } =
        await deployFixture();
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, issuer.address, 0, 3);
      await token.connect(issuanceAuthority).setMintAllowance(issuer.address, holder.address, 0, 1);
      await token.connect(issuer).mint(issuer.address, 3);
      await token.connect(issuer).transfer(burner.address, 1);
      await policy.connect(policyAuthority).setBlocked(
        await token.getAddress(),
        [issuer.address, burner.address],
        true,
      );
      await expect(token.connect(issuer).transfer(holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(issuer.address);
      await expect(token.connect(issuer).mint(holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(issuer.address);
      await expect(token.connect(burner).burn(1))
        .to.be.revertedWithCustomError(policy, "UserBlocked")
        .withArgs(burner.address);
    });

    it("rejects transfers to the token contract itself", async function () {
      const { token, issuanceAuthority, issuer } = await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 2n);
      await expect(token.connect(issuer).transfer(await token.getAddress(), 1))
        .to.be.revertedWithCustomError(token, "InvalidTokenRecipient");
    });

    it("keeps a pre-pause permit usable only after cooldown and compliance", async function () {
      const { token, policy, admin, policyAuthority, issuanceAuthority, issuer, pauser, holder, spender } =
        await deployFixture();
      await authorizeAndMint(token, issuanceAuthority, issuer, issuer.address, 10n);
      const deadline = (await time.latest()) + 7200;
      const { chainId } = await ethers.provider.getNetwork();
      const nonce = await token.nonces(issuer.address);
      const value = 4n;
      const signature = await issuer.signTypedData(
        { name: NAME, version: "1", chainId, verifyingContract: await token.getAddress() },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { owner: issuer.address, spender: spender.address, value, nonce, deadline },
      );
      const parsed = ethers.Signature.from(signature);
      await token.connect(pauser).pause();
      await token.permit(
        issuer.address,
        spender.address,
        value,
        deadline,
        parsed.v,
        parsed.r,
        parsed.s,
      );

      await expect(token.connect(spender).transferFrom(issuer.address, holder.address, 1))
        .to.be.revertedWithCustomError(token, "EnforcedPause");
      await time.increaseTo(await token.unpauseAvailableAt());
      await token.connect(admin).unpause();

      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [spender.address], true);
      await expect(token.connect(spender).transferFrom(issuer.address, holder.address, 1))
        .to.be.revertedWithCustomError(policy, "UserBlocked");
      await policy.connect(policyAuthority).setBlocked(await token.getAddress(), [spender.address], false);
      await token.connect(spender).transferFrom(issuer.address, holder.address, 1);
      expect(await token.balanceOf(holder.address)).to.equal(1);

      await expect(token.permit(
        issuer.address,
        spender.address,
        value,
        deadline,
        parsed.v,
        parsed.r,
        parsed.s,
      )).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });
  });
});
