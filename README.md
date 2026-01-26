## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

## Deploy with WalletConnect (mobile wallet)

This lets you deploy contracts in `src/` by **connecting your mobile wallet** via WalletConnect (QR / deep link) and signing the deployment transaction on your phone.

### Prerequisites

- A WalletConnect **Project ID** from `https://cloud.walletconnect.com`
- An RPC URL for the target chain (e.g. your Alchemy/Infura URL, or another provider)

### Setup

```shell
# 1) Compile contracts (writes artifacts into ./out)
forge build

# 2) Install the WalletConnect deploy tool dependencies
npm install

# 3) Configure WalletConnect Project ID
export WC_PROJECT_ID="YOUR_WALLETCONNECT_PROJECT_ID"
```

### Deploy a contract from `src/`

Example: deploy `src/Counter.sol`'s `Counter` contract to mainnet (chain id 1):

```shell
npm run deploy:wc -- --contract Counter --chain-id 1 --rpc-url <your_rpc_url>
```

The script will print a QR code in your terminal. Scan it with your mobile wallet, approve the connection, then approve the deployment transaction.

## Deterministic deploys with CREATE2 (multi-chain)

If you pass `--create2` the tool will deploy your contract via a CREATE2 factory and:

- Print the **predicted address** before sending the tx
- Iterate over multiple chains with `--chains [...]`
- Prompt your mobile wallet to sign/send **once per chain**

### Important: "same address on all chains" requirement

CREATE2 addresses are derived from:

- the **factory address**
- the **salt**
- the **init code hash** (bytecode + constructor args)

So you only get the **same resulting address across chains** if the **factory address is the same on every chain** (and you keep the salt + init code identical).

### Multi-chain example

```shell
npm run deploy:wc -- \
  --contract Counter \
  --create2 \
  --salt my-release-salt \
  --chains '[{"name":"mainnet","chainId":1,"rpcUrl":"<rpc1>"},{"name":"base","chainId":8453,"rpcUrl":"<rpc2>"}]'
```

### Using a chains file

This repo includes a starter `chains.json` you can edit. Then:

```shell
npm run deploy:wc -- --contract Counter --create2 --salt my-release-salt --chains-file chains.json
```

## Verification (Etherscan-style explorers)

You can optionally auto-verify after each deployment (one verification per chain) using Foundry's `forge verify-contract`.

### Requirements

- An explorer API key (Etherscan-style). Set it as:
  - `ETHERSCAN_API_KEY=...` (recommended), or pass `--etherscan-api-key ...`

### Example

```shell
export ETHERSCAN_API_KEY="YOUR_KEY"

npm run deploy:wc -- \
  --contract UniversalRecoveryDelegate \
  --create2 \
  --salt hacked-wallet-recovery/UniversalRecoveryDelegate/v1 \
  --paymaster 0x0000000000000000000000000000000000000000 \
  --chains-file chains.json \
  --verify
```

### Two-phase behavior (fast signing)

With `--verify`, the script now:

- Deploys (or skips-if-exists) across **all chains first**
- Then runs a **verification phase** across all collected deployments

If you rerun the script, it will attempt verification again; if a contract is already verified, `forge verify-contract` should exit cleanly.

## Deployment recording

After each chain is processed (including when a CREATE2 target already exists and is skipped), the script writes:

- `deployments.json` (source of truth)
- `deployments.ts` (generated, in the format keyed by chain id and referencing per-contract `*_ABI` constants)

### Choosing the CREATE2 factory

- Default: `--factory eip2470`
  - Uses the commonly-used singleton factory address `0xce0042B868300000d44A59004Da54A005ffdcf9f`
  - If that address is not deployed on a given chain, the tool will error and tell you what to do.

- Auto-fallback (default): `--auto-factory true`
  - If the requested factory (e.g. EIP-2470) is **not deployed** on a chain, the script will **deploy `Create2Factory` on that chain and continue**.
  - **Important**: this means the resulting CREATE2 address on that chain will differ from chains where the factory address is different.
  - Disable with `--auto-factory false` if you want strict “same address across chains” behavior.

- Per-chain factory (address will usually differ per chain): `--factory deploy`

```shell
npm run deploy:wc -- --contract Counter --create2 --salt my-salt --factory deploy --chains '[{"chainId":1,"rpcUrl":"<rpc>"}]'
```

- Custom factory address (if you deployed your own factory at a known address): `--factory address --factory-address 0x...`

### Handling "already deployed"

By default the script skips chains where code already exists at the predicted address. To make it error instead:

```shell
npm run deploy:wc -- --contract Counter --create2 --salt my-salt --if-exists error --chains '[{"chainId":1,"rpcUrl":"<rpc>"}]'
```

### Constructor args / value

- Constructor args are passed as a JSON array string:

```shell
npm run deploy:wc -- --contract MyContract --chain-id 1 --rpc-url <rpc_url> --constructor-args '[123,"0x0000000000000000000000000000000000000000"]'
```

- ETH value can be sent with `--value` (in ether units):

```shell
npm run deploy:wc -- --contract PayableContract --chain-id 1 --rpc-url <rpc_url> --value 0.01
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
