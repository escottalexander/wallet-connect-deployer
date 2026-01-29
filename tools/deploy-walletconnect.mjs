import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import EthereumProviderPkg from "@walletconnect/ethereum-provider";
import { ethers } from "ethers";

function getEthereumProviderClass() {
  // Handle ESM/CJS export differences:
  // - ESM: export default EthereumProvider OR export { EthereumProvider }
  // - CJS: module.exports = { EthereumProvider } (default import becomes an object)
  const candidate =
    EthereumProviderPkg?.EthereumProvider ??
    EthereumProviderPkg?.default?.EthereumProvider ??
    EthereumProviderPkg?.default ??
    EthereumProviderPkg;

  if (!candidate) {
    throw new Error(`Could not load @walletconnect/ethereum-provider (no exports found)`);
  }
  if (typeof candidate?.init !== "function") {
    throw new Error(
      `@walletconnect/ethereum-provider loaded, but no .init() found. ` +
        `Export keys: ${Object.keys(EthereumProviderPkg ?? {}).join(", ")}`
    );
  }
  return candidate;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function usageAndExit(msg) {
  if (msg) console.error(`\nError: ${msg}\n`);
  console.error(
    [
      "WalletConnect deploy (mobile wallet signer)",
      "",
      "Prereqs:",
      "  - forge build",
      "  - WalletConnect Project ID (https://cloud.walletconnect.com)",
      "",
      "Env:",
      "  WC_PROJECT_ID=...      (required unless --project-id)",
      "",
      "Args:",
      "  --contract Counter     (required, contract name)",
      "  --chains '[{\"chainId\":1,\"rpcUrl\":\"https://...\"}]' (optional, multi-chain JSON array)",
      "  --chain-id 1           (optional if --chains is provided)",
      "  --rpc-url https://...  (optional if --chains is provided)",
      "  --constructor-args '[1,\"0x...\"]'   (optional, JSON array string)",
      "  --paymaster 0x...      (optional, convenience for UniversalRecoveryDelegate(address paymaster); conflicts with --constructor-args)",
      "  --value 0.01           (optional, ETH value to send, in ether)",
      "  --artifact out/...json (optional, explicit artifact path)",
      "",
      "CREATE2 mode:",
      "  --create2              (deploy via a CREATE2 factory)",
      "  --salt <string|0x..>   (required with --create2; string is hashed to bytes32, hex is zero-padded to bytes32)",
      "  --factory eip2470|deploy|address   (default: eip2470)",
      "  --factory-address 0x.. (required if --factory address)",
      "  --if-exists skip|error (default: skip)",
      "  --auto-factory true|false (optional, default: true; if the requested factory isn't deployed on a chain, deploy Create2Factory and retry on that chain)",
      "",
      "Gas tuning:",
      "  --gas-limit <number>          (optional, explicit gas limit)",
      "  --gas-multiplier <number>     (optional, default: 1.2; used when estimating gas)",
      "",
      "Verification:",
      "  --verify                      (optional, runs `forge verify-contract` after deploy)",
      "  --etherscan-api-key <key>     (optional, defaults to env ETHERSCAN_API_KEY)",
      "  --verify-watch true|false     (optional, default: true)",
      "  --verify-strict               (optional, fail the script if verification fails; default is best-effort)",
      "",
      "Error handling:",
      "  --strict                      (optional, stop the run on the first chain error; default is to continue)",
      "",
      "Example:",
      "  WC_PROJECT_ID=... node tools/deploy-walletconnect.mjs --contract Counter --chain-id 1 --rpc-url https://eth.llamarpc.com",
      "  WC_PROJECT_ID=... node tools/deploy-walletconnect.mjs --contract Counter --create2 --salt my-salt --chains '[{\"chainId\":1,\"rpcUrl\":\"https://eth.llamarpc.com\"},{\"chainId\":8453,\"rpcUrl\":\"https://mainnet.base.org\"}]'",
      "",
    ].join("\n")
  );
  process.exit(1);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadChainsFile({ repoRoot, chainsFile }) {
  const full = path.isAbsolute(chainsFile) ? chainsFile : path.join(repoRoot, chainsFile);
  const raw = await fs.readFile(full, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`--chains-file must point to a non-empty JSON array`);
  }
  return arr;
}

function toUpperSnake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeDeploymentsFiles({
  repoRoot,
  chainId,
  chainName,
  contractName,
  address,
  abi
}) {
  const jsonPath = path.join(repoRoot, "deployments.json");
  const tsPath = path.join(repoRoot, "deployments.ts");

  const state = await readJsonIfExists(jsonPath, { chains: {} });
  if (!state.chains) state.chains = {};
  const cid = String(chainId);
  if (!state.chains[cid]) state.chains[cid] = { name: chainName ?? null, contracts: {} };
  if (!state.chains[cid].contracts) state.chains[cid].contracts = {};
  state.chains[cid].name = chainName ?? state.chains[cid].name ?? null;
  state.chains[cid].contracts[contractName] = { address, abi };

  await fs.writeFile(jsonPath, JSON.stringify(state, null, 2) + "\n", "utf8");

  // Generate TS file in the requested format:
  // 1: { Contract: { address: "...", abi: CONTRACT_ABI } },
  // ...
  const allContracts = new Map(); // contractName -> abi
  for (const c of Object.values(state.chains)) {
    for (const [cn, info] of Object.entries(c.contracts ?? {})) {
      allContracts.set(cn, info.abi);
    }
  }

  const abiConsts = [];
  for (const [cn, cAbi] of allContracts.entries()) {
    const constName = `${toUpperSnake(cn)}_ABI`;
    abiConsts.push(`export const ${constName} = ${JSON.stringify(cAbi, null, 2)} as const;`);
  }

  const chainEntries = [];
  const sortedChainIds = Object.keys(state.chains).map(Number).sort((a, b) => a - b);
  for (const id of sortedChainIds) {
    const c = state.chains[String(id)];
    const nameComment = c?.name ? `// ${c.name}\n` : "";
    const contractLines = [];
    for (const [cn, info] of Object.entries(c.contracts ?? {})) {
      const constName = `${toUpperSnake(cn)}_ABI`;
      contractLines.push(
        `    ${cn}: {\n` +
          `      address: ${JSON.stringify(info.address)},\n` +
          `      abi: ${constName},\n` +
          `    },`
      );
    }
    chainEntries.push(
      `${nameComment}  ${id}: {\n` + contractLines.join("\n") + `\n  },`
    );
  }

  const out =
    `// This file is generated by tools/deploy-walletconnect.mjs. Do not edit by hand.\n` +
    `\n` +
    abiConsts.join("\n\n") +
    `\n\n` +
    `export const DEPLOYMENTS = {\n` +
    chainEntries.join("\n\n") +
    `\n} as const;\n`;

  await fs.writeFile(tsPath, out, "utf8");
}

async function findArtifactInOutDir({ repoRoot, contractName }) {
  const outDir = path.join(repoRoot, "out");
  if (!(await fileExists(outDir))) {
    throw new Error(
      `Could not find ./out. Run "forge build" first (it generates artifacts into ./out).`
    );
  }

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const matches = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        matches.push(...(await walk(full)));
      } else if (e.isFile() && e.name === `${contractName}.json`) {
        matches.push(full);
      }
    }
    return matches;
  }

  const matches = await walk(outDir);
  if (matches.length === 0) {
    throw new Error(
      `No artifact found for contract "${contractName}". Expected something like out/<Source>.sol/${contractName}.json (did you run "forge build"?)`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple artifacts matched "${contractName}.json":\n- ${matches.join(
        "\n- "
      )}\n\nPass --artifact to disambiguate.`
    );
  }
  return matches[0];
}

function extractAbiAndBytecode(artifactJson) {
  const abi = artifactJson.abi;
  const bytecode =
    artifactJson?.bytecode?.object ??
    artifactJson?.bytecode ??
    artifactJson?.evm?.bytecode?.object;

  if (!abi || !Array.isArray(abi)) {
    throw new Error(`Artifact is missing "abi" (array).`);
  }
  if (!bytecode || typeof bytecode !== "string") {
    throw new Error(
      `Artifact is missing bytecode (expected bytecode.object or evm.bytecode.object).`
    );
  }
  if (bytecode === "0x" || bytecode.length < 3) {
    throw new Error(
      `Artifact bytecode looks empty. Did the contract compile successfully?`
    );
  }

  return { abi, bytecode: bytecode.startsWith("0x") ? bytecode : `0x${bytecode}` };
}

function artifactHasConstructor(artifactJson) {
  const abi = artifactJson?.abi;
  if (Array.isArray(abi) && abi.some((x) => x?.type === "constructor")) return true;
  try {
    const raw = artifactJson?.rawMetadata;
    if (typeof raw === "string" && raw.length > 0) {
      const md = JSON.parse(raw);
      const mdAbi = md?.output?.abi;
      if (Array.isArray(mdAbi) && mdAbi.some((x) => x?.type === "constructor")) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function getConstructorTypes({ abi, contractName, constructorArgs, paymasterProvided }) {
  if (!constructorArgs || constructorArgs.length === 0) return [];

  // Convenience: UniversalRecoveryDelegate(address paymaster)
  if (paymasterProvided && contractName === "UniversalRecoveryDelegate") {
    return ["address"];
  }

  const ctor = (abi ?? []).find((x) => x && x.type === "constructor");
  const inputs = ctor?.inputs ?? [];
  return inputs.map((i) => i.type);
}

function encodeConstructorArgs({ abi, contractName, constructorArgs, paymasterProvided }) {
  const types = getConstructorTypes({ abi, contractName, constructorArgs, paymasterProvided });
  if (types.length === 0) {
    if (constructorArgs && constructorArgs.length > 0) {
      throw new Error(
        `Constructor args were provided but no constructor types could be determined for ${contractName}. ` +
          `Run "forge build" to refresh artifacts (constructor ABI may be missing), or pass correct --constructor-args for a contract with a constructor in the ABI.`
      );
    }
    return "0x";
  }
  return ethers.AbiCoder.defaultAbiCoder().encode(types, constructorArgs);
}

function getContractIdentifierFromArtifact({ artifactJson, contractName }) {
  // Try to use the compilation target path from standard JSON metadata if present.
  // Foundry artifacts often include `rawMetadata` (stringified standard JSON output metadata).
  try {
    const raw = artifactJson.rawMetadata;
    if (typeof raw === "string" && raw.length > 0) {
      const md = JSON.parse(raw);
      const target = md?.settings?.compilationTarget;
      if (target && typeof target === "object") {
        const keys = Object.keys(target);
        if (keys.length > 0) {
          return `${keys[0]}:${contractName}`;
        }
      }
    }
  } catch {
    // ignore
  }

  // Fallback: infer from artifact path structure (out/<Source>.sol/<Contract>.json)
  const sourceName = artifactJson?.metadata?.settings?.compilationTarget
    ? Object.keys(artifactJson.metadata.settings.compilationTarget ?? {})[0]
    : null;
  if (sourceName) return `${sourceName}:${contractName}`;

  // Last resort: assume src/<Contract>.sol
  return `src/${contractName}.sol:${contractName}`;
}

function getCompilerVersionFromArtifact(artifactJson) {
  try {
    const raw = artifactJson.rawMetadata;
    if (typeof raw === "string" && raw.length > 0) {
      const md = JSON.parse(raw);
      const v = md?.compiler?.version;
      if (typeof v === "string" && v.length > 0) {
        return v.startsWith("v") ? v : `v${v}`;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getOptimizerRunsFromArtifact(artifactJson) {
  try {
    const raw = artifactJson.rawMetadata;
    if (typeof raw === "string" && raw.length > 0) {
      const md = JSON.parse(raw);
      const opt = md?.settings?.optimizer;
      if (opt && opt.enabled && typeof opt.runs === "number") return String(opt.runs);
      // If optimizer disabled, pass 0 (forge accepts it)
      if (opt && opt.enabled === false) return "0";
    }
  } catch {
    // ignore
  }
  return null;
}

function runForgeVerify({
  address,
  contractIdentifier,
  chainId,
  rpcUrl,
  compilerVersion,
  optimizerRuns,
  encodedConstructorArgs,
  etherscanApiKey,
  watch
}) {
  const args = [
    "verify-contract",
    address,
    contractIdentifier,
    "--chain",
    String(chainId),
    "--rpc-url",
    rpcUrl,
    "--constructor-args",
    encodedConstructorArgs
  ];

  if (watch) args.push("--watch");
  if (compilerVersion) args.push("--compiler-version", compilerVersion);
  if (optimizerRuns != null) args.push("--num-of-optimizations", String(optimizerRuns));
  if (etherscanApiKey) args.push("--etherscan-api-key", etherscanApiKey);

  console.log(`Running: forge ${args.join(" ")}`);
  const res = spawnSync("forge", args, { stdio: "inherit" });
  return res.status === 0;
}

function parseChains({ args }) {
  if (args.chains) {
    const arr = JSON.parse(args.chains);
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`--chains must be a non-empty JSON array`);
    }
    return arr.map((c, idx) => {
      if (!c || typeof c !== "object") throw new Error(`--chains[${idx}] must be an object`);
      const chainId = Number(c.chainId);
      const rpcUrl = c.rpcUrl ?? c.rpc;
      const rpcUrlsRaw = c.rpcUrls ?? c.rpcs ?? (rpcUrl ? [rpcUrl] : []);
      const rpcUrls = Array.isArray(rpcUrlsRaw) ? rpcUrlsRaw.filter((u) => typeof u === "string" && u.length > 0) : [];
      if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`--chains[${idx}].chainId must be a positive number`);
      if ((!rpcUrl || typeof rpcUrl !== "string") && rpcUrls.length === 0) throw new Error(`--chains[${idx}] must include rpcUrl (string) or rpcUrls (string[])`);
      const primary = (rpcUrl && typeof rpcUrl === "string") ? rpcUrl : rpcUrls[0];
      const uniq = Array.from(new Set([primary, ...rpcUrls]));
      return { name: c.name ?? `chainId:${chainId}`, chainId, rpcUrl: primary, rpcUrls: uniq };
    });
  }

  const chainIdRaw = args["chain-id"];
  const rpcUrl = args["rpc-url"];
  if (!chainIdRaw || !rpcUrl) {
    usageAndExit("Either provide --chains JSON array, or both --chain-id and --rpc-url");
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isFinite(chainId) || chainId <= 0) usageAndExit("--chain-id must be a positive number");
  return [{ name: `chainId:${chainId}`, chainId, rpcUrl, rpcUrls: [rpcUrl] }];
}

function parseSaltBytes32(saltArg) {
  if (!saltArg) throw new Error(`--salt is required in --create2 mode`);
  if (typeof saltArg !== "string") throw new Error(`--salt must be a string`);
  if (saltArg.startsWith("0x")) {
    return ethers.zeroPadValue(saltArg, 32);
  }
  return ethers.id(saltArg); // keccak256(utf8Bytes(saltArg))
}

const DEFAULT_EIP2470_FACTORY_ADDRESS = "0xce0042B868300000d44A59004Da54A005ffdcf9f";
const CREATE2_FACTORY_ABI = [
  "event Deployed(address indexed addr, bytes32 indexed salt)",
  "function deploy(bytes initCode, bytes32 salt) payable returns (address addr)"
];

const APP_METADATA = {
  name: "wallet-connect-deployer",
  description: "Deploy Foundry contracts via WalletConnect (mobile wallet signer)",
  // In Node there is no window.location.origin, so WalletConnect needs an explicit non-empty origin/url.
  url: "https://wallet-connect-deployer.local",
  icons: []
};

function parseGasLimit(args) {
  if (args["gas-limit"] == null) return null;
  const n = Number(args["gas-limit"]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--gas-limit must be a positive number`);
  return BigInt(Math.floor(n));
}

function parseGasMultiplier(args) {
  const raw = args["gas-multiplier"] ?? "1.2";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--gas-multiplier must be a positive number`);
  return n;
}

function applyGasMultiplier(gasEstimate, mult) {
  // gasEstimate is bigint, mult is number
  const scaled = BigInt(Math.ceil(Number(gasEstimate) * mult));
  // Add a tiny constant buffer in case mult was close to 1.0
  return scaled + 10_000n;
}

async function getCreate2FactoryAddress({ args }) {
  const mode = (args.factory ?? "eip2470").toString();
  if (mode === "eip2470") return DEFAULT_EIP2470_FACTORY_ADDRESS;
  if (mode === "address") {
    if (!args["factory-address"]) throw new Error(`--factory-address is required when --factory address`);
    return ethers.getAddress(args["factory-address"]);
  }
  if (mode === "deploy") return null; // deployed per-chain
  throw new Error(`Unknown --factory "${mode}". Use eip2470|deploy|address.`);
}

function parseBool(v, defaultValue) {
  if (v == null) return defaultValue;
  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  return defaultValue;
}

let _wcSingleton = null;

async function connectWalletOnce({ projectId, chains }) {
  if (_wcSingleton) return _wcSingleton;

  const allChainIds = chains.map((c) => c.chainId);
  const firstChainId = allChainIds[0];
  if (!firstChainId) throw new Error("No chains provided");
  const rpcMap = Object.fromEntries(chains.map((c) => [c.chainId, c.rpcUrl]));

  const EthereumProvider = getEthereumProviderClass();
  const wcProvider = await EthereumProvider.init({
    projectId,
    // Request access to all chains up-front so the session is valid for multi-chain usage.
    chains: allChainIds,
    rpcMap,
    metadata: APP_METADATA,
    // Reduce noisy relay logs like "onRelayMessage() -> failed to process an inbound message"
    // (these can happen due to stale/expired topics; we only surface actionable errors ourselves).
    logger: "silent",
    showQrModal: false,
    // Keep one WC client for the whole run; separate DB/table to avoid colliding with other apps.
    storageOptions: {
      database: "wallet-connect-deployer",
      table: `wc-session`
    }
  });

  wcProvider.on("display_uri", (uri) => {
    console.log("\nScan this WalletConnect QR with your mobile wallet:\n");
    qrcode.generate(uri, { small: true });
    console.log(`\nWalletConnect URI:\n${uri}\n`);
  });

  await wcProvider.connect({ chains: allChainIds, rpcMap });

  _wcSingleton = { wcProvider };
  return _wcSingleton;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contractName = args.contract;
  const projectId = args["project-id"] ?? process.env.WC_PROJECT_ID;

  if (!contractName) usageAndExit("--contract is required");
  if (!projectId) usageAndExit("WalletConnect project id missing (set WC_PROJECT_ID or pass --project-id)");

  const repoRoot = process.cwd();
  if (args["chains-file"] && args.chains) {
    usageAndExit("Use either --chains-file or --chains, not both");
  }

  if (args["chains-file"]) {
    const loaded = await loadChainsFile({ repoRoot, chainsFile: args["chains-file"] });
    args.chains = JSON.stringify(loaded);
  }

  const chains = parseChains({ args });
  const create2Mode = Boolean(args.create2);
  const ifExists = (args["if-exists"] ?? "skip").toString();
  if (ifExists !== "error" && ifExists !== "skip") {
    usageAndExit('--if-exists must be "skip" or "error"');
  }
  const artifactPath = args.artifact
    ? path.isAbsolute(args.artifact)
      ? args.artifact
      : path.join(repoRoot, args.artifact)
    : await findArtifactInOutDir({ repoRoot, contractName });

  const artifactStr = await fs.readFile(artifactPath, "utf8");
  const artifactJson = JSON.parse(artifactStr);
  const { abi, bytecode } = extractAbiAndBytecode(artifactJson);
  const contractIdentifier = getContractIdentifierFromArtifact({ artifactJson, contractName });
  const compilerVersion = getCompilerVersionFromArtifact(artifactJson);
  const optimizerRuns = getOptimizerRunsFromArtifact(artifactJson);

  if (args.paymaster && args["constructor-args"]) {
    throw new Error(`Use either --paymaster or --constructor-args, not both`);
  }

  let constructorArgs = args["constructor-args"] ? JSON.parse(args["constructor-args"]) : [];
  if (!Array.isArray(constructorArgs)) {
    throw new Error(`--constructor-args must be a JSON array string, e.g. '[123,\"0xabc...\"]'`);
  }

  if (args.paymaster) {
    const paymaster = ethers.getAddress(String(args.paymaster));
    if (contractName !== "UniversalRecoveryDelegate") {
      console.warn(
        `Warning: --paymaster was provided but --contract is "${contractName}". ` +
          `Proceeding by passing it as the only constructor argument.`
      );
    }
    constructorArgs = [paymaster];
  }

  const valueWei = args.value != null ? ethers.parseEther(String(args.value)) : 0n;
  const gasLimitOverride = parseGasLimit(args);
  const gasMultiplier = parseGasMultiplier(args);
  const verify = Boolean(args.verify);
  const verifyWatch = (args["verify-watch"] ?? "true").toString() !== "false";
  const verifyStrict = Boolean(args["verify-strict"]);
  const strict = Boolean(args.strict);
  const etherscanApiKey = args["etherscan-api-key"] ?? process.env.ETHERSCAN_API_KEY ?? null;
  const autoFactory = parseBool(args["auto-factory"], true);

  const verifyQueue = [];

  const paymasterProvided = Boolean(args.paymaster);
  if (constructorArgs.length > 0 && !artifactHasConstructor(artifactJson) && !paymasterProvided) {
    throw new Error(
      `Constructor args were provided, but the artifact ABI for ${contractName} has no constructor. ` +
        `Run "forge build" and try again.`
    );
  }
  if (paymasterProvided && contractName === "UniversalRecoveryDelegate" && !artifactHasConstructor(artifactJson)) {
    throw new Error(
      `UniversalRecoveryDelegate now has a constructor, but your artifact ABI does not include it. ` +
        `Run "forge build" to regenerate out/ artifacts, then retry.`
    );
  }

  const encodedConstructorArgs = encodeConstructorArgs({
    abi,
    contractName,
    constructorArgs,
    paymasterProvided
  });
  const deployData = ethers.concat([bytecode, encodedConstructorArgs]);

  const saltBytes32 = create2Mode ? parseSaltBytes32(args.salt) : null;
  const factoryAddressGlobal = create2Mode ? await getCreate2FactoryAddress({ args }) : null;

  console.log(`Artifact: ${path.relative(repoRoot, artifactPath)}`);
  if (verify) {
    console.log(`Verify: enabled (contract=${contractIdentifier})`);
    if (!etherscanApiKey) {
      console.log(`Warning: no Etherscan API key provided (set ETHERSCAN_API_KEY or pass --etherscan-api-key)`);
    }
  }
  if (create2Mode) {
    console.log(`CREATE2: enabled`);
    console.log(`Salt (bytes32): ${saltBytes32}`);
    console.log(`Factory mode: ${(args.factory ?? "eip2470").toString()}`);
    if (factoryAddressGlobal) console.log(`Factory address (requested): ${factoryAddressGlobal}`);
  }

  for (const chain of chains) {
    console.log(`\n=== Deploying to ${chain.name} (chainId=${chain.chainId}) ===`);
    try {

      // Prefer RPC (read side) from the chains config; allow fallbacks via rpcUrls
      let rpcProvider;
      let rpcUrlUsed;
      let lastRpcErr;
      for (const url of (chain.rpcUrls ?? [chain.rpcUrl])) {
        try {
          rpcProvider = new ethers.JsonRpcProvider(url, chain.chainId);
          await rpcProvider.getBlockNumber(); // forces a real request
          rpcUrlUsed = url;
          if (url !== chain.rpcUrl) console.log(`Using fallback rpcUrl: ${url}`);
          lastRpcErr = undefined;
          break;
        } catch (e) {
          lastRpcErr = e;
        }
      }
      if (!rpcProvider) {
        throw lastRpcErr ?? new Error(`No working rpcUrl found for chainId=${chain.chainId}`);
      }
      if (!rpcUrlUsed) rpcUrlUsed = chain.rpcUrl;

      const { wcProvider } = await connectWalletOnce({ projectId, chains });

      // Switch wallet to the target chain (best-effort; some wallets require manual switch)
      try {
        await wcProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ethers.toBeHex(chain.chainId) }]
        });
      } catch {
        // ignored; we'll validate chainId below
      }

      {
        // Important: ethers' BrowserProvider caches a "network" and throws if it changes.
        // Since we're intentionally switching chains, create a fresh BrowserProvider per chain step.
        const walletProvider = new ethers.BrowserProvider(wcProvider);
        const signer = await walletProvider.getSigner();
        const signerAddress = await signer.getAddress();
        const walletNet = await walletProvider.getNetwork();
        console.log(`Connected wallet: ${signerAddress}`);
        console.log(`Wallet network: chainId=${walletNet.chainId.toString()}`);
        if (walletNet.chainId !== BigInt(chain.chainId)) {
          throw new Error(
            `Wallet is on chainId=${walletNet.chainId.toString()} but this step targets chainId=${chain.chainId}. ` +
              `Switch your wallet network to ${chain.name} and re-run.`
          );
        }

        if (!create2Mode) {
          const factory = new ethers.ContractFactory(abi, bytecode, signer);
          const deployOverrides = { value: valueWei };
          if (gasLimitOverride) deployOverrides.gasLimit = gasLimitOverride;
          const contract = await factory.deploy(...constructorArgs, deployOverrides);
          const tx = contract.deploymentTransaction();
          if (tx?.hash) console.log(`Deploy tx: ${tx.hash}`);
          await rpcProvider.waitForTransaction(tx.hash);
          const deployedAddr = await contract.getAddress();
          console.log(`Deployed ${contractName} to: ${deployedAddr}`);
          await writeDeploymentsFiles({
            repoRoot,
            chainId: chain.chainId,
            chainName: chain.name,
            contractName,
            address: deployedAddr,
            abi
          });
          if (verify) verifyQueue.push({ chain, rpcUrlUsed, address: deployedAddr });
          continue;
        }

        // CREATE2 path
        let factoryAddress = factoryAddressGlobal;
        const deployPerChainFactory = async () => {
          const factoryArtifactPath = await findArtifactInOutDir({ repoRoot, contractName: "Create2Factory" });
          const fa = JSON.parse(await fs.readFile(factoryArtifactPath, "utf8"));
          const { abi: fAbi, bytecode: fBytecode } = extractAbiAndBytecode(fa);
          const create2Factory = new ethers.ContractFactory(fAbi, fBytecode, signer);
          const deployed = await create2Factory.deploy(gasLimitOverride ? { gasLimit: gasLimitOverride } : {});
          await rpcProvider.waitForTransaction(deployed.deploymentTransaction().hash);
          const addr = await deployed.getAddress();
          console.log(`Deployed per-chain Create2Factory at: ${addr}`);
          await writeDeploymentsFiles({
            repoRoot,
            chainId: chain.chainId,
            chainName: chain.name,
            contractName: "Create2Factory",
            address: addr,
            abi: fAbi
          });
          return addr;
        };

        if (!factoryAddress) {
          // --factory deploy: always deploy per-chain factory
          factoryAddress = await deployPerChainFactory();
        } else {
          // --factory eip2470/address: ensure it's actually deployed; optionally fallback to deploying our own.
          const codeAtRequested = await rpcProvider.getCode(factoryAddress);
          if (!codeAtRequested || codeAtRequested === "0x") {
            if (!autoFactory) {
              throw new Error(
                `No contract code at CREATE2 factory address ${factoryAddress} on chainId=${chain.chainId}. ` +
                  `Enable fallback with --auto-factory true or use --factory deploy.`
              );
            }
            console.warn(
              `No code at requested CREATE2 factory (${factoryAddress}) on ${chain.name}. ` +
                `Falling back to deploying Create2Factory (NOTE: deterministic address will differ on this chain).`
            );
            factoryAddress = await deployPerChainFactory();
          }
        }

        // At this point, factoryAddress must be deployed
        const code = await rpcProvider.getCode(factoryAddress);
        if (!code || code === "0x") throw new Error(`CREATE2 factory still missing code at ${factoryAddress}`);

        const initCodeHash = ethers.keccak256(deployData);
        const predicted = ethers.getCreate2Address(factoryAddress, saltBytes32, initCodeHash);
        console.log(`Predicted ${contractName} address: ${predicted}`);

        const existing = await rpcProvider.getCode(predicted);
        if (existing && existing !== "0x") {
          const msg = `Contract already exists at ${predicted} on ${chain.name}`;
          if (ifExists === "skip") {
            console.log(`${msg} (skipping)`);
            await writeDeploymentsFiles({
              repoRoot,
              chainId: chain.chainId,
              chainName: chain.name,
              contractName,
              address: predicted,
              abi
            });
            if (verify) verifyQueue.push({ chain, rpcUrlUsed, address: predicted });
            continue;
          }
          throw new Error(msg);
        }

        const create2Factory = new ethers.Contract(factoryAddress, CREATE2_FACTORY_ABI, signer);
        const populated = await create2Factory.deploy.populateTransaction(deployData, saltBytes32, { value: valueWei });
        populated.from = signerAddress;

        const decodeReturnedAddress = (ret) => {
          if (!ret || ret === "0x") return null;
          // Expected return type: address (ABI-encoded as 32 bytes, right-aligned)
          if (ret.length !== 66) return null;
          return ethers.getAddress(`0x${ret.slice(26)}`);
        };

        const simulateFactoryDeploy = async (gasLimit) => {
          // Some RPCs under-estimate gas for nested CREATE2. We dry-run an eth_call and
          // check if the factory returns the expected non-zero address.
          const ret = await rpcProvider.call({
            ...populated,
            from: signerAddress,
            gasLimit
          });
          return decodeReturnedAddress(ret);
        };

        let gasLimitToUse = gasLimitOverride;
        if (!gasLimitToUse) {
          const est = await rpcProvider.estimateGas(populated);
          gasLimitToUse = applyGasMultiplier(est, gasMultiplier);
          console.log(`Estimated gas: ${est.toString()} (using gasLimit=${gasLimitToUse.toString()})`);
        } else {
          console.log(`Using --gas-limit=${gasLimitToUse.toString()}`);
        }

        // Preflight the CREATE2 call: if we get a zero return address, it's almost always OOG
        // during creation (factory doesn't revert). Bump gas to avoid "mined but no code" cases.
        try {
          const returned = await simulateFactoryDeploy(gasLimitToUse);
          if (returned === ethers.ZeroAddress) {
            const MAX_CREATE2_GAS = 5_000_000n;
            const bumped = gasLimitOverride
              ? null
              : (gasLimitToUse * 3n < MAX_CREATE2_GAS ? gasLimitToUse * 3n : MAX_CREATE2_GAS);

            if (!bumped) {
              throw new Error(
                `CREATE2 factory returned zero address in a dry-run with --gas-limit=${gasLimitToUse.toString()}. ` +
                  `Increase --gas-limit or --gas-multiplier.`
              );
            }

            const returned2 = await simulateFactoryDeploy(bumped);
            if (returned2 && returned2 !== ethers.ZeroAddress) {
              console.warn(
                `WARNING: RPC gas estimate was too low for CREATE2 on ${chain.name}. ` +
                  `Bumping gasLimit from ${gasLimitToUse.toString()} -> ${bumped.toString()}`
              );
              gasLimitToUse = bumped;
            } else {
              throw new Error(
                `CREATE2 dry-run still returned zero address even with gasLimit=${bumped.toString()}. ` +
                  `The initCode may be failing/reverting or the chain's call gas cap is too low.`
              );
            }
          } else if (returned && returned.toLowerCase() !== predicted.toLowerCase()) {
            console.warn(
              `WARNING: CREATE2 dry-run returned ${returned}, but predicted address is ${predicted}. ` +
                `Proceeding, but this suggests a non-standard factory.`
            );
          }
        } catch (e) {
          // If the RPC errors during eth_call (rate limit, gas cap, etc), don't block sending.
          console.warn(
            `WARNING: CREATE2 dry-run failed on ${chain.name} (${chain.chainId}) (continuing): ${e?.message ?? String(e)}`
          );
        }

        // Preflight funds: WalletConnect signers will reject if balance < gasLimit * maxFeePerGas (+ value).
        try {
          const feeData = await rpcProvider.getFeeData();
          const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
          if (maxFeePerGas != null) {
            const bal = await rpcProvider.getBalance(signerAddress);
            const maxCost = gasLimitToUse * maxFeePerGas + valueWei;
            if (bal < maxCost) {
              const short = maxCost - bal;
              throw new Error(
                `Insufficient funds on ${chain.name} (chainId=${chain.chainId}). ` +
                  `balance=${bal.toString()} wei, maxCost≈${maxCost.toString()} wei (gasLimit=${gasLimitToUse.toString()}, maxFeePerGas≈${maxFeePerGas.toString()}). ` +
                  `Short by ${short.toString()} wei. Fund ${signerAddress} with native gas token on this chain or lower --gas-limit.`
              );
            }
          }
        } catch (e) {
          // If we can't fetch fee data / balance (RPC limitations), don't block sending.
          // But do block on an explicit insufficient-funds error we generated above.
          if (String(e?.message ?? "").includes("Insufficient funds on")) throw e;
          console.warn(
            `WARNING: Balance preflight skipped on ${chain.name} (${chain.chainId}) (continuing): ${e?.message ?? String(e)}`
          );
        }

        const tx = await signer.sendTransaction({ ...populated, gasLimit: gasLimitToUse });
        console.log(`Deploy tx: ${tx.hash}`);
        const receipt = await rpcProvider.waitForTransaction(tx.hash);
        console.log(`Mined in block: ${receipt?.blockNumber}`);

        if (receipt && receipt.status != null && receipt.status !== 1) {
          throw new Error(`Deployment transaction reverted (status=${receipt.status})`);
        }

        const deployedCode = await rpcProvider.getCode(predicted);
        if (!deployedCode || deployedCode === "0x") {
          throw new Error(
            `Deployment tx mined but no code found at predicted address ${predicted}. ` +
              `This usually means the CREATE2 factory address (${factoryAddress}) is missing/wrong on this chain, ` +
              `or the tx did not actually execute the expected factory.`
          );
        }
        console.log(`Deployed ${contractName} to: ${predicted}`);
        await writeDeploymentsFiles({
          repoRoot,
          chainId: chain.chainId,
          chainName: chain.name,
          contractName,
          address: predicted,
          abi
        });
        if (verify) verifyQueue.push({ chain, rpcUrlUsed, address: predicted });
      }
    } catch (e) {
      if (strict) throw e;
      console.warn(`Chain ${chain.name} (${chain.chainId}) failed (continuing): ${e?.message ?? String(e)}`);
      continue;
    }
  }

  if (verify) {
    console.log(`\n=== Verification phase (${verifyQueue.length} chain(s)) ===`);
    for (const item of verifyQueue) {
      const { chain, rpcUrlUsed, address } = item;
      try {
        const encodedArgs = encodedConstructorArgs;
        const ok = runForgeVerify({
          address,
          contractIdentifier,
          chainId: chain.chainId,
          rpcUrl: rpcUrlUsed ?? chain.rpcUrl,
          compilerVersion,
          optimizerRuns,
          encodedConstructorArgs: encodedArgs,
          etherscanApiKey,
          watch: verifyWatch
        });
        if (!ok) {
          const msg = `Verification failed for ${contractName} on ${chain.name} (${chain.chainId})`;
          if (verifyStrict) throw new Error(msg);
          console.warn(msg);
        }
      } catch (e) {
        if (verifyStrict) throw e;
        console.warn(`Verification error on ${chain.name} (${chain.chainId}) (continuing): ${e?.message ?? String(e)}`);
      }
    }
  }

  // Disconnect once at the end (best-effort)
  if (_wcSingleton?.wcProvider) {
    await _wcSingleton.wcProvider.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});

