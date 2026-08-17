import { HardhatUserConfig } from "hardhat/config"
import "@nomicfoundation/hardhat-ethers"
import "@nomicfoundation/hardhat-chai-matchers"
import "@nomicfoundation/hardhat-network-helpers"
import "@typechain/hardhat"
import "hardhat-gas-reporter"
import "solidity-coverage"

// Compiler settings are part of the security boundary. The compiler version,
// EVM target, viaIR and optimizer settings all affect runtime bytecode and the
// policy codehash approved by PipoSecurityToken.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.36",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  // No live networks and no accounts. This repository exists to be read,
  // compiled and tested — not to deploy. Deployment stays in the platform
  // repository where the keys and the release process live.
  networks: {
    hardhat: {
      chainId: 31337,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
}

export default config
