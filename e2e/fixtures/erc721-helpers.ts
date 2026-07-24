// Compile MinimalErc721.sol via solc-js, deploy to anvil, return
// the contract address. solc-js is the official JS Solidity compiler
// — pure JavaScript, no native dependencies. Compile time on this
// trivial contract is ~200 ms; we memoize within a test-process so
// repeat tests reuse the same bytecode.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// Anvil's first pre-funded account (derived from the canonical
// 'test test … junk' mnemonic). We use this to deploy + mint; the
// minted token then gets sent TO the wallet's HD address so the
// wallet sees itself as owner and lets the user send.
const ANVIL_DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

type SolcOutput = {
  contracts: Record<string, Record<string, {
    abi: unknown[];
    evm: { bytecode: { object: string } };
  }>>;
  errors?: { severity: 'error' | 'warning'; formattedMessage: string }[];
};

const compileCache = new Map<string, { bytecode: Hex; abi: readonly unknown[] }>();

/** Compile a minimal contract from `e2e/fixtures/`. Caches per-file
 *  results so repeat calls within a process don't re-invoke solc-js
 *  (each compile is ~200 ms on the trivial contracts we use). */
function compileContract(filename: string, contractName: string): { bytecode: Hex; abi: readonly unknown[] } {
  const key = `${filename}::${contractName}`;
  const hit = compileCache.get(key);
  if (hit) return hit;

  const source = readFileSync(resolve(__dirname, filename), 'utf8');
  // solc-js loaded lazily — keeps cold-start of unrelated tests fast
  // (this module is imported by anvil-gated suites + the fixture
  // server's /compile endpoint).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const solc = require('solc') as { compile: (input: string) => string };
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [filename]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }))) as SolcOutput;
  const hardErrors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (hardErrors.length > 0) {
    throw new Error(`solc errors compiling ${filename}:\n${hardErrors.map((e) => e.formattedMessage).join('\n')}`);
  }
  const c = output.contracts[filename]?.[contractName];
  if (!c) throw new Error(`solc compiled ${filename} but no ${contractName} artifact`);
  const result = { bytecode: `0x${c.evm.bytecode.object}` as Hex, abi: c.abi as readonly unknown[] };
  compileCache.set(key, result);
  return result;
}

function compileErc721(): { bytecode: Hex; abi: readonly unknown[] } {
  return compileContract('MinimalErc721.sol', 'MinimalErc721');
}

/** Compile MinimalErc1155.sol. Exported for the dapp-side bytecode
 *  endpoint; tests use the deploy/mint wrappers below directly. */
export function compileErc1155(): { bytecode: Hex; abi: readonly unknown[] } {
  return compileContract('MinimalErc1155.sol', 'MinimalErc1155');
}

/** Exported counterpart for the dapp-side bytecode endpoint. */
export function compileErc721ForDapp(): { bytecode: Hex; abi: readonly unknown[] } {
  return compileErc721();
}

/** Compile MinimalErc20.sol. Used by the dapp-side bytecode endpoint
 *  to power the ERC-20 multi-scenario panel (deploy / mint / transfer
 *  / approve / watchAsset against a freshly deployed token). */
export function compileErc20(): { bytecode: Hex; abi: readonly unknown[] } {
  return compileContract('MinimalErc20.sol', 'MinimalErc20');
}

/** Spin up a viem WalletClient pointed at anvil with the pre-funded
 *  deployer key. Used for deploy + mint — the WALLET under test
 *  signs the eventual safeTransferFrom via its own SW. */
function deployerClient(rpcUrl: string): { wallet: WalletClient; pub: PublicClient; account: Address } {
  const account = privateKeyToAccount(ANVIL_DEPLOYER_PK);
  const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
  const pub = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  return { wallet, pub, account: account.address };
}

/** Default tokenURI for tests — embedded SVG of the wallet's brand
 *  pile glyph (same path as ShitPileGlyph in dashboard.tsx) on a
 *  transparent background. Self-contained data URI, no IPFS / HTTP
 *  dependency. Wallet's NFT cards render this directly via the
 *  data: URI path in fetchMetadataJson + resolveTokenUri. */
export const DEFAULT_TEST_TOKEN_URI =
  'data:application/json;base64,eyJuYW1lIjoiU2hpdCBQaWxlIFRlc3QiLCJkZXNjcmlwdGlvbiI6IlRlc3QgTkZUIGZvciB3YWxsZXQgZTJlIOKAlCBlbWJlZGRlZCBTVkcsIG5vIElQRlMuIiwiaW1hZ2UiOiJkYXRhOmltYWdlL3N2Zyt4bWw7YmFzZTY0LFBITjJaeUI0Yld4dWN6MGlhSFIwY0RvdkwzZDNkeTUzTXk1dmNtY3ZNakF3TUM5emRtY2lJSFpwWlhkQ2IzZzlJakFnTUNBeE1qZ2dNVEk0SWo0OFp5QjBjbUZ1YzJadmNtMDlJblJ5WVc1emJHRjBaU2cwSURrcElqNDhjR0YwYUNCa1BTSk5JREU0SURFd01DQlJJREU0SURnNExDQXpNQ0E0TmlCUklESTRJRGN5TENBME5DQTJPQ0JSSURReUlEVTBMQ0EyTUNBMU1DQlJJRFU0SURNMkxDQTNOaUF6TkNCUklEYzBJREl5TENBNE9DQXlNaUJSSURreUlESXlMQ0E1TUNBeU9DQlJJRGsySURJMkxDQTVOaUF6TmlCUklERXdNaUEwTUN3Z09UWWdORGdnVVNBeE1ESWdOVFlzSURreUlEWXdJRkVnTVRBd0lEWTRMQ0E0TmlBM01pQlJJRGswSURneUxDQTNPQ0E0TkNCUklEZzBJRGsyTENBMk5pQTVOaUJSSURjd0lERXdOQ3dnTlRRZ01UQXlJRXdnTWpJZ01UQXlJRm9pSUdacGJHdzlJaU00UWpaQ00wRWlJSE4wY205clpUMGlJekF3TUNJZ2MzUnliMnRsTFhkcFpIUm9QU0kxSWlCemRISnZhMlV0YkdsdVpXcHZhVzQ5SW5KdmRXNWtJaTgrUEdOcGNtTnNaU0JqZUQwaU56Z2lJR041UFNJME5DSWdjajBpTXk0MUlpQm1hV3hzUFNJak1EQXdJaTgrUEdOcGNtTnNaU0JqZUQwaU9UQWlJR041UFNJME5DSWdjajBpTXk0MUlpQm1hV3hzUFNJak1EQXdJaTgrUEdOcGNtTnNaU0JqZUQwaU56Z3VOeUlnWTNrOUlqUXpMakVpSUhJOUlqRXVNaUlnWm1sc2JEMGlJMlptWmlJdlBqeGphWEpqYkdVZ1kzZzlJamt3TGpjaUlHTjVQU0kwTXk0eElpQnlQU0l4TGpJaUlHWnBiR3c5SWlObVptWWlMejQ4Y0dGMGFDQmtQU0pOSURjMklEVTJJRkVnT0RRZ05qSXNJRGsySURVMklpQm1hV3hzUFNKdWIyNWxJaUJ6ZEhKdmEyVTlJaU13TURBaUlITjBjbTlyWlMxM2FXUjBhRDBpTXlJZ2MzUnliMnRsTFd4cGJtVmpZWEE5SW5KdmRXNWtJaTgrUEM5blBqd3ZjM1puUGc9PSJ9';

/** Deploy MinimalErc721 to anvil, mint `tokenId` to `recipient`,
 *  return the deployed contract address. */
export async function deployAndMintErc721(
  rpcUrl: string,
  recipient: Address,
  tokenId: bigint,
  tokenUri: string = DEFAULT_TEST_TOKEN_URI,
): Promise<Address> {
  const { bytecode, abi } = compileErc721();
  const { wallet, pub, account } = deployerClient(rpcUrl);

  const txHash = await wallet.deployContract({
    abi,
    bytecode,
    args: [tokenUri],
    account,
    chain: foundry,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) throw new Error('deploy produced no contract address');
  const contractAddr = receipt.contractAddress;

  // Mint via raw calldata so we don't have to fight viem's `abi` type
  // gymnastics for the runtime-loaded ABI shape.
  const mintCalldata = encodeFunctionData({
    abi: [{
      type: 'function', name: 'mint', stateMutability: 'nonpayable',
      inputs: [
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'tokenId' },
      ],
      outputs: [],
    }],
    functionName: 'mint',
    args: [recipient, tokenId],
  });
  const mintTx = await wallet.sendTransaction({
    account,
    chain: foundry,
    to: contractAddr,
    data: mintCalldata,
  });
  await pub.waitForTransactionReceipt({ hash: mintTx });
  return contractAddr;
}

/** Deploy MinimalErc1155 + mint `amount` of `tokenId` to `recipient`.
 *  Symmetric to `deployAndMintErc721` but uses the 1155 mint
 *  signature `(to, id, amount)`. Returns the deployed address. */
export async function deployAndMintErc1155(
  rpcUrl: string,
  recipient: Address,
  tokenId: bigint,
  amount: bigint = 1n,
  tokenUri: string = DEFAULT_TEST_TOKEN_URI,
): Promise<Address> {
  const { bytecode, abi } = compileErc1155();
  const { wallet, pub, account } = deployerClient(rpcUrl);

  const txHash = await wallet.deployContract({
    abi, bytecode, args: [tokenUri], account, chain: foundry,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) throw new Error('1155 deploy produced no contract address');
  const contract = receipt.contractAddress;

  const mintCalldata = encodeFunctionData({
    abi: [{
      type: 'function', name: 'mint', stateMutability: 'nonpayable',
      inputs: [
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'id' },
        { type: 'uint256', name: 'amount' },
      ],
      outputs: [],
    }],
    functionName: 'mint',
    args: [recipient, tokenId, amount],
  });
  const mintTx = await wallet.sendTransaction({
    account, chain: foundry, to: contract, data: mintCalldata,
  });
  await pub.waitForTransactionReceipt({ hash: mintTx });
  return contract;
}

/** Read ERC-1155 `balanceOf(account, id)` — analogous to `readOwnerOf`
 *  for the fungible side. Used to verify a 1155 safeTransferFrom
 *  actually moved tokens on-chain. */
export async function readErc1155Balance(
  rpcUrl: string,
  contract: Address,
  account: Address,
  tokenId: bigint,
): Promise<bigint> {
  const { pub } = deployerClient(rpcUrl);
  const result = await pub.readContract({
    address: contract,
    abi: [{
      type: 'function', name: 'balanceOf', stateMutability: 'view',
      inputs: [
        { type: 'address', name: 'account' },
        { type: 'uint256', name: 'id' },
      ],
      outputs: [{ type: 'uint256' }],
    }],
    functionName: 'balanceOf',
    args: [account, tokenId],
  });
  return result as bigint;
}

/** Read `ownerOf(tokenId)` directly from the deployed contract — used
 *  by the e2e test to verify a safeTransferFrom actually changed
 *  on-chain state after the wallet broadcast its tx. */
export async function readOwnerOf(
  rpcUrl: string,
  contract: Address,
  tokenId: bigint,
): Promise<Address> {
  const { pub } = deployerClient(rpcUrl);
  const result = await pub.readContract({
    address: contract,
    abi: [{
      type: 'function', name: 'ownerOf', stateMutability: 'view',
      inputs: [{ type: 'uint256', name: 'tokenId' }],
      outputs: [{ type: 'address' }],
    }],
    functionName: 'ownerOf',
    args: [tokenId],
  });
  return result as Address;
}
