import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Compliance } from "../typechain-types";

describe("Compliance", function () {
  async function deployFixture() {
    const [deployer, admin, ops, otherOps, officer, outsider, alice, bob] = await ethers.getSigners();

    const compliance = (await ethers.deployContract("Compliance", [admin.address])) as unknown as Compliance;
    // Any address stands in for a token here: the contract keys by token address
    // and never calls into it.
    const token = deployer.address;
    const otherToken = outsider.address;
    await compliance.connect(admin).grantRole(await compliance.opsRole(token), ops.address);
    await compliance.connect(admin).grantRole(await compliance.opsRole(otherToken), otherOps.address);
    await compliance.connect(admin).grantRole(await compliance.COMPLIANCE_ROLE(), officer.address);

    return { compliance, admin, ops, otherOps, officer, outsider, alice, bob, token, otherToken };
  }

  describe("default posture", function () {
    it("permits an unknown address, because verification lives off-chain", async function () {
      const { compliance, token, alice } = await deployFixture();

      // The whole design rests on this: the chain carries refusals only, so an
      // address nobody has acted on is allowed rather than pending.
      await compliance.checkIsCompliant(token, alice.address);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(true);
      expect(await compliance.sanctionEpoch()).to.equal(1);
    });

    it("rejects a zero admin", async function () {
      const factory = await ethers.getContractFactory("Compliance");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "AccessControlInvalidDefaultAdmin",
      );
    });

    it("starts with one delayed default admin", async function () {
      const { compliance, admin } = await deployFixture();
      const defaultRole = await compliance.DEFAULT_ADMIN_ROLE();

      expect(await compliance.defaultAdmin()).to.equal(admin.address);
      expect(await compliance.defaultAdminDelay()).to.equal(3600);
      expect(await compliance.hasRole(defaultRole, admin.address)).to.equal(true);
    });
  });

  describe("blocklist", function () {
    it("blocks per token and lifts again, without touching other tokens", async function () {
      const { compliance, ops, officer, token, otherToken, alice, bob } = await deployFixture();

      await expect(compliance.connect(ops).setBlocked(token, [alice.address], true))
        .to.emit(compliance, "BlocklistUpdated")
        .withArgs(token, [alice.address], true);

      await expect(compliance.checkIsCompliant(token, alice.address))
        .to.be.revertedWithCustomError(compliance, "UserBlocked")
        .withArgs(alice.address);

      // Scoped: the same address is fine elsewhere, and others are unaffected.
      await compliance.checkIsCompliant(otherToken, alice.address);
      await compliance.checkIsCompliant(token, bob.address);

      await expect(compliance.connect(ops).setBlocked(token, [alice.address], false))
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(ops.address);
      await compliance.connect(officer).setBlocked(token, [alice.address], false);
      await compliance.checkIsCompliant(token, alice.address);
    });

    it("blocks across every token when scoped to the zero address", async function () {
      const { compliance, officer, token, otherToken, alice } = await deployFixture();

      await compliance.connect(officer).setBlocked(ethers.ZeroAddress, [alice.address], true);

      await expect(compliance.checkIsCompliant(token, alice.address)).to.be.revertedWithCustomError(
        compliance,
        "UserBlocked",
      );
      await expect(compliance.checkIsCompliant(otherToken, alice.address)).to.be.revertedWithCustomError(
        compliance,
        "UserBlocked",
      );
    });

    it("refuses an empty batch and the zero address", async function () {
      const { compliance, ops, token } = await deployFixture();

      await expect(compliance.connect(ops).setBlocked(token, [], true)).to.be.revertedWithCustomError(
        compliance,
        "EmptyAccounts",
      );
      await expect(
        compliance.connect(ops).setBlocked(token, [ethers.ZeroAddress], true),
      ).to.be.revertedWithCustomError(compliance, "ZeroAddress");
    });
  });

  describe("sanctions", function () {
    it("sanctions globally and removes individually", async function () {
      const { compliance, officer, token, otherToken, alice } = await deployFixture();

      await expect(compliance.connect(officer).addSanctions([alice.address]))
        .to.emit(compliance, "SanctionsAdded")
        .withArgs(1, [alice.address]);

      expect(await compliance.isSanctioned(alice.address)).to.equal(true);
      // A sanction is not scoped to a token, unlike a block.
      await expect(compliance.checkIsCompliant(token, alice.address)).to.be.revertedWithCustomError(
        compliance,
        "UserSanctioned",
      );
      await expect(compliance.checkIsCompliant(otherToken, alice.address)).to.be.revertedWithCustomError(
        compliance,
        "UserSanctioned",
      );

      await compliance.connect(officer).removeSanctions([alice.address]);
      expect(await compliance.isSanctioned(alice.address)).to.equal(false);
      await compliance.checkIsCompliant(token, alice.address);
    });

    it("clears the whole list by moving epoch, at constant cost", async function () {
      const { compliance, officer, token, alice, bob } = await deployFixture();
      await compliance.connect(officer).addSanctions([alice.address, bob.address]);

      const before = await compliance.sanctionEpoch();
      await expect(compliance.connect(officer).resetSanctions())
        .to.emit(compliance, "SanctionsReset")
        .withArgs(before + 1n);
      expect(await compliance.sanctionEpoch()).to.equal(before + 1n);

      // Both are released without either address having been touched.
      expect(await compliance.isSanctioned(alice.address)).to.equal(false);
      expect(await compliance.isSanctioned(bob.address)).to.equal(false);
      await compliance.checkIsCompliant(token, alice.address);
      await compliance.checkIsCompliant(token, bob.address);
    });

    it("replaces the list wholesale, retiring the previous one", async function () {
      const { compliance, officer, alice, bob } = await deployFixture();
      await compliance.connect(officer).addSanctions([alice.address]);

      await expect(compliance.connect(officer).setSanctions([bob.address, bob.address]))
        .to.emit(compliance, "SanctionsReset")
        .withArgs(2)
        .and.to.emit(compliance, "SanctionsAdded")
        .withArgs(2, [bob.address, bob.address]);

      // The old entry is gone by epoch, the new one is present, and the repeat
      // in the input is harmless.
      expect(await compliance.isSanctioned(alice.address)).to.equal(false);
      expect(await compliance.isSanctioned(bob.address)).to.equal(true);

      await expect(compliance.connect(officer).setSanctions([])).to.be.revertedWithCustomError(
        compliance,
        "EmptyAccounts",
      );
      expect(await compliance.isSanctioned(bob.address)).to.equal(true);
    });

    it("survives a stale entry from an earlier epoch", async function () {
      const { compliance, officer, alice } = await deployFixture();

      await compliance.connect(officer).addSanctions([alice.address]);
      await compliance.connect(officer).resetSanctions();
      // Removing something already retired must not resurrect it or underflow.
      await expect(compliance.connect(officer).removeSanctions([alice.address]))
        .to.emit(compliance, "SanctionsRemoved")
        .withArgs(2, [alice.address]);
      expect(await compliance.isSanctioned(alice.address)).to.equal(false);
    });
  });

  describe("freezes", function () {
    it("freezes until a date and lapses on its own", async function () {
      const { compliance, officer, token, alice } = await deployFixture();
      const until = (await time.latest()) + 3600;

      await expect(compliance.connect(officer).setFreeze(token, alice.address, until))
        .to.emit(compliance, "FreezeSet")
        .withArgs(token, alice.address, until);

      await expect(compliance.checkIsCompliant(token, alice.address))
        .to.be.revertedWithCustomError(compliance, "UserFrozen")
        .withArgs(alice.address, until);

      // No transaction is needed to release it — the freeze simply expires.
      await time.increaseTo(until + 1);
      await compliance.checkIsCompliant(token, alice.address);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(true);
    });

    it("freezes across every token and can be lifted early", async function () {
      const { compliance, officer, token, otherToken, alice } = await deployFixture();
      const until = (await time.latest()) + 3600;

      await compliance.connect(officer).setFreeze(ethers.ZeroAddress, alice.address, until);
      await expect(compliance.checkIsCompliant(otherToken, alice.address)).to.be.revertedWithCustomError(
        compliance,
        "UserFrozen",
      );

      await compliance.connect(officer).setFreeze(ethers.ZeroAddress, alice.address, 0);
      await compliance.checkIsCompliant(token, alice.address);
    });

    it("reports the later of the token and global freeze as the effective expiry", async function () {
      const { compliance, officer, token, alice } = await deployFixture();
      const now = await time.latest();
      const soon = now + 3600;
      const later = now + 7200;

      // Whichever freeze is checked first, the holder is immobile until the
      // later of the two — so that is the date the refusal has to carry. Naming
      // the earlier one would tell a holder to come back while still frozen.
      await compliance.connect(officer).setFreeze(token, alice.address, soon);
      await compliance.connect(officer).setFreeze(ethers.ZeroAddress, alice.address, later);
      await expect(compliance.checkIsCompliant(token, alice.address))
        .to.be.revertedWithCustomError(compliance, "UserFrozen")
        .withArgs(alice.address, later);

      // The same holds with the ordering reversed, so the answer does not
      // depend on which mapping happens to be consulted first.
      await compliance.connect(officer).setFreeze(token, alice.address, later);
      await compliance.connect(officer).setFreeze(ethers.ZeroAddress, alice.address, soon);
      await expect(compliance.checkIsCompliant(token, alice.address))
        .to.be.revertedWithCustomError(compliance, "UserFrozen")
        .withArgs(alice.address, later);

      // The flag form shares the same helper, so it cannot drift from the
      // reverting one: still refused after the earlier freeze has lapsed.
      await time.increaseTo(soon + 1);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(false);
      await time.increaseTo(later + 1);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(true);
      await compliance.checkIsCompliant(token, alice.address);
    });

    it("refuses a freeze that is already over", async function () {
      const { compliance, ops, token, alice } = await deployFixture();
      const past = (await time.latest()) - 1;

      await expect(
        compliance.connect(ops).setFreeze(token, alice.address, past),
      ).to.be.revertedWithCustomError(compliance, "FreezeInPast");
      await expect(
        compliance.connect(ops).setFreeze(token, ethers.ZeroAddress, (await time.latest()) + 60),
      ).to.be.revertedWithCustomError(compliance, "ZeroAddress");
    });
  });

  describe("transfer checks", function () {
    it("checks every distinct non-zero participant", async function () {
      const { compliance, ops, officer, outsider, token, alice, bob } = await deployFixture();

      await compliance.checkTransfer(token, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 1);

      await compliance.connect(ops).setBlocked(token, [outsider.address], true);
      await expect(compliance.checkTransfer(token, outsider.address, alice.address, bob.address, 1))
        .to.be.revertedWithCustomError(compliance, "UserBlocked")
        .withArgs(outsider.address);
      await compliance.connect(officer).setBlocked(token, [outsider.address], false);

      await compliance.connect(officer).addSanctions([alice.address]);
      await expect(compliance.checkTransfer(token, outsider.address, alice.address, bob.address, 1))
        .to.be.revertedWithCustomError(compliance, "UserSanctioned")
        .withArgs(alice.address);
      await compliance.connect(officer).removeSanctions([alice.address]);

      const until = (await time.latest()) + 3600;
      await compliance.connect(ops).setFreeze(token, bob.address, until);
      await expect(compliance.checkTransfer(token, outsider.address, alice.address, bob.address, 1))
        .to.be.revertedWithCustomError(compliance, "UserFrozen")
        .withArgs(bob.address, until);
    });

    it("deduplicates participants that occupy more than one transfer role", async function () {
      const { compliance, ops, outsider, token, alice, bob } = await deployFixture();

      const dedupedGas = await compliance.checkTransfer.estimateGas(
        token,
        alice.address,
        alice.address,
        alice.address,
        1,
      );
      const distinctGas = await compliance.checkTransfer.estimateGas(
        token,
        outsider.address,
        alice.address,
        bob.address,
        1,
      );
      expect(dedupedGas).to.be.lessThan(distinctGas);

      await compliance.connect(ops).setBlocked(token, [alice.address], true);
      await expect(compliance.checkTransfer(token, alice.address, alice.address, alice.address, 1))
        .to.be.revertedWithCustomError(compliance, "UserBlocked")
        .withArgs(alice.address);
    });
  });

  describe("the non-reverting form", function () {
    it("reports false for each refusal reason in turn", async function () {
      const { compliance, ops, officer, token, otherToken, alice } = await deployFixture();

      // isCompliant duplicates checkIsCompliant's decision without reverting, so
      // every reason it can refuse for is exercised here — a divergence between
      // the two would let a UI offer a transfer the token then rejects.
      await compliance.connect(ops).setBlocked(token, [alice.address], true);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(false);
      await compliance.connect(officer).setBlocked(token, [alice.address], false);

      await compliance.connect(officer).setBlocked(ethers.ZeroAddress, [alice.address], true);
      expect(await compliance.isCompliant(otherToken, alice.address)).to.equal(false);
      await compliance.connect(officer).setBlocked(ethers.ZeroAddress, [alice.address], false);

      await compliance.connect(officer).addSanctions([alice.address]);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(false);
      await compliance.connect(officer).removeSanctions([alice.address]);

      const until = (await time.latest()) + 3600;
      await compliance.connect(ops).setFreeze(token, alice.address, until);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(false);
      // Scoped: the freeze is on one token only.
      expect(await compliance.isCompliant(otherToken, alice.address)).to.equal(true);
      await compliance.connect(officer).setFreeze(token, alice.address, 0);

      await compliance.connect(officer).setFreeze(ethers.ZeroAddress, alice.address, until);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(false);
      await compliance.connect(officer).setFreeze(ethers.ZeroAddress, alice.address, 0);

      expect(await compliance.isCompliant(token, alice.address)).to.equal(true);
    });
  });

  describe("input validation on every list", function () {
    it("refuses an empty batch wherever one is required", async function () {
      const { compliance, ops, officer, token } = await deployFixture();

      // Thunks rather than an array of live promises: building the array would
      // fire every call at once and leave the later rejections unhandled until
      // the loop got round to awaiting them.
      for (const call of [
        () => compliance.connect(ops).setBlocked(token, [], true),
        () => compliance.connect(officer).addSanctions([]),
        () => compliance.connect(officer).removeSanctions([]),
        () => compliance.connect(officer).setSanctions([]),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(compliance, "EmptyAccounts");
      }
    });

    it("refuses the zero address wherever an account is named", async function () {
      const { compliance, ops, officer, token } = await deployFixture();
      const zero = ethers.ZeroAddress;

      const freezeUntil = (await time.latest()) + 60;
      for (const call of [
        () => compliance.connect(ops).setBlocked(token, [zero], true),
        () => compliance.connect(officer).addSanctions([zero]),
        () => compliance.connect(officer).removeSanctions([zero]),
        () => compliance.connect(officer).setSanctions([zero]),
        () => compliance.connect(ops).setFreeze(token, zero, freezeUntil),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(compliance, "ZeroAddress");
      }
    });

    it("caps every account batch", async function () {
      const { compliance, ops, officer, token, alice } = await deployFixture();
      const oversized = Array(201).fill(alice.address);

      for (const call of [
        () => compliance.connect(ops).setBlocked(token, oversized, true),
        () => compliance.connect(officer).addSanctions(oversized),
        () => compliance.connect(officer).removeSanctions(oversized),
        () => compliance.connect(officer).setSanctions(oversized),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(compliance, "BatchTooLarge").withArgs(201);
      }
      expect(await compliance.MAX_BATCH_SIZE()).to.equal(200);
    });

    it("lets a compliance officer lift a freeze that was never set", async function () {
      const { compliance, officer, token, alice } = await deployFixture();

      // until == 0 skips the in-the-past check, so clearing is always allowed —
      // including when there is nothing to clear.
      await expect(compliance.connect(officer).setFreeze(token, alice.address, 0))
        .to.emit(compliance, "FreezeSet")
        .withArgs(token, alice.address, 0);
      expect(await compliance.isCompliant(token, alice.address)).to.equal(true);
    });
  });

  describe("authority", function () {
    it("keeps each ops role token-scoped and impose-only", async function () {
      const { compliance, ops, otherOps, officer, token, otherToken, alice } = await deployFixture();
      const until = (await time.latest()) + 60;

      expect(await compliance.opsRole(token)).not.to.equal(await compliance.opsRole(otherToken));
      await expect(compliance.opsRole(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        compliance,
        "ZeroAddress",
      );
      await compliance.connect(ops).setBlocked(token, [alice.address], true);
      await expect(compliance.connect(ops).setBlocked(token, [alice.address], false))
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(ops.address);
      await compliance.connect(officer).setBlocked(token, [alice.address], false);
      await compliance.connect(ops).setFreeze(token, alice.address, until);
      await expect(compliance.connect(ops).setFreeze(token, alice.address, until - 1))
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(ops.address);
      await expect(compliance.connect(ops).setFreeze(token, alice.address, 0))
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(ops.address);
      await compliance.connect(ops).setFreeze(token, alice.address, until + 60);
      await compliance.connect(officer).setFreeze(token, alice.address, 0);
      await compliance.connect(otherOps).setBlocked(otherToken, [alice.address], true);
      await compliance.connect(officer).setBlocked(otherToken, [alice.address], false);

      for (const call of [
        () => compliance.connect(ops).setBlocked(otherToken, [alice.address], true),
        () => compliance.connect(otherOps).setFreeze(token, alice.address, until),
        () => compliance.connect(ops).addSanctions([alice.address]),
        () => compliance.connect(ops).removeSanctions([alice.address]),
        () => compliance.connect(ops).setSanctions([alice.address]),
        () => compliance.connect(ops).resetSanctions(),
        () => compliance.connect(ops).setBlocked(ethers.ZeroAddress, [alice.address], true),
        () => compliance.connect(ops).setFreeze(ethers.ZeroAddress, alice.address, until),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator");
      }
    });

    it("lets compliance and admin operate global controls", async function () {
      const { compliance, admin, ops, officer, outsider, token, alice } = await deployFixture();

      for (const operator of [admin, officer]) {
        await compliance.connect(operator).setBlocked(ethers.ZeroAddress, [alice.address], true);
        await compliance.connect(operator).setBlocked(ethers.ZeroAddress, [alice.address], false);
        await compliance.connect(operator).setFreeze(ethers.ZeroAddress, alice.address, (await time.latest()) + 60);
        await compliance.connect(operator).setFreeze(ethers.ZeroAddress, alice.address, 0);
        await compliance.connect(operator).addSanctions([alice.address]);
        await compliance.connect(operator).removeSanctions([alice.address]);
        await compliance.connect(operator).setSanctions([alice.address]);
        await compliance.connect(operator).resetSanctions();
      }

      await expect(compliance.connect(outsider).setBlocked(token, [alice.address], true))
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(outsider.address);
      await expect(compliance.connect(outsider).addSanctions([alice.address]))
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(outsider.address);
      await expect(
        compliance.connect(outsider).setFreeze(token, alice.address, (await time.latest()) + 60),
      )
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(outsider.address);
      await expect(compliance.connect(outsider).resetSanctions())
        .to.be.revertedWithCustomError(compliance, "UnauthorizedComplianceOperator")
        .withArgs(outsider.address);

      // OPS remains distinct from an outsider for its scoped operations.
      await compliance.connect(ops).setBlocked(token, [alice.address], true);
    });

    it("only the admin administers roles", async function () {
      const { compliance, ops, outsider, token } = await deployFixture();
      const role = await compliance.opsRole(token);

      await expect(compliance.connect(ops).grantRole(role, outsider.address)).to.be.revertedWithCustomError(
        compliance,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("transfers the sole default admin in two delayed steps", async function () {
      const { compliance, admin, outsider } = await deployFixture();

      await compliance.connect(admin).beginDefaultAdminTransfer(outsider.address);
      const [pending, schedule] = await compliance.pendingDefaultAdmin();
      expect(pending).to.equal(outsider.address);
      await expect(compliance.connect(outsider).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(compliance, "AccessControlEnforcedDefaultAdminDelay")
        .withArgs(schedule);

      await time.increaseTo(schedule + 1n);
      await compliance.connect(outsider).acceptDefaultAdminTransfer();
      expect(await compliance.defaultAdmin()).to.equal(outsider.address);
      expect(await compliance.hasRole(await compliance.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(false);
    });

    it("cannot lose the last default admin in one step", async function () {
      const { compliance, admin, outsider } = await deployFixture();
      const role = await compliance.DEFAULT_ADMIN_ROLE();

      await expect(compliance.connect(admin).renounceRole(role, admin.address))
        .to.be.revertedWithCustomError(compliance, "AccessControlEnforcedDefaultAdminDelay")
        .withArgs(0);
      await expect(compliance.connect(admin).revokeRole(role, admin.address)).to.be.revertedWithCustomError(
        compliance,
        "AccessControlEnforcedDefaultAdminRules",
      );
      await expect(compliance.connect(admin).grantRole(role, outsider.address)).to.be.revertedWithCustomError(
        compliance,
        "AccessControlEnforcedDefaultAdminRules",
      );
      expect(await compliance.defaultAdmin()).to.equal(admin.address);
    });
  });
});
