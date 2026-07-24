// Bundled function selector table — the wallet's first-pass calldata
// decoder. Goal: cover the ~80% of mainnet tx volume (ERC-20/721/1155 +
// Uniswap V2/V3 + Permit2 + Seaport + Multicall3 + common DeFi)
// without any network call, so the sign-confirm screen can show
// "swapExactTokensForTokens(amountIn=…, amountOutMin=…, path=…, to=…)"
// instead of "0x38ed1739 (260 bytes)" on first paint.
//
// Lookups that miss this table fall through to the Sourcify ABI
// fetch path in the SW (see `get-contract-abi`), then to raw selector
// display as last resort. We deliberately AVOID 4byte.directory:
//   - 4byte accepts community-submitted signatures with no verification,
//     so selector collisions (e.g. `drainWallet(address)` colliding
//     with a known-good 4-byte prefix) can be planted to make
//     malicious calls render with benign names.
//   - Every lookup leaks a "this user called function X at time Y"
//     fingerprint to a third-party service.
//
// Sourcify, by contrast, ties signatures to verified bytecode of a
// specific contract — collisions can't be planted.
//
// Maintenance: add new entries as we encounter dapps the wallet's
// users hit frequently. Don't bloat with rarely-used variants.

import type { Abi } from 'viem';

// ─── ERC-20 (a few extras beyond what COMMON_TX_ABI covers) ───────────────
const ERC20_EXTRA_ABI: Abi = [
  // Non-standard but widespread; some tokens use `increaseAllowance` /
  // `decreaseAllowance` instead of approve to avoid the 0→N race.
  { type: 'function', name: 'increaseAllowance', stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'addedValue' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decreaseAllowance', stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'subtractedValue' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'permit', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'owner' },
      { type: 'address', name: 'spender' },
      { type: 'uint256', name: 'value' },
      { type: 'uint256', name: 'deadline' },
      { type: 'uint8',   name: 'v' },
      { type: 'bytes32', name: 'r' },
      { type: 'bytes32', name: 's' },
    ], outputs: [] },
];

// ─── ERC-721 ──────────────────────────────────────────────────────────────
const ERC721_ABI: Abi = [
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'tokenId' },
    ], outputs: [] },
  // Overload with data — different selector.
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'tokenId' },
      { type: 'bytes',   name: 'data' },
    ], outputs: [] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'operator' },
      { type: 'bool',    name: 'approved' },
    ], outputs: [] },
];

// ─── ERC-1155 ─────────────────────────────────────────────────────────────
const ERC1155_ABI: Abi = [
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'id' },
      { type: 'uint256', name: 'amount' },
      { type: 'bytes',   name: 'data' },
    ], outputs: [] },
  { type: 'function', name: 'safeBatchTransferFrom', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address',   name: 'from' },
      { type: 'address',   name: 'to' },
      { type: 'uint256[]', name: 'ids' },
      { type: 'uint256[]', name: 'amounts' },
      { type: 'bytes',     name: 'data' },
    ], outputs: [] },
];

// ─── Uniswap V2 Router02 ──────────────────────────────────────────────────
// SushiSwap / PancakeSwap forks share these selectors (router code is
// largely identical), so this section also decodes those.
const UNISWAP_V2_ABI: Abi = [
  { type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256',   name: 'amountIn' },
      { type: 'uint256',   name: 'amountOutMin' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapTokensForExactTokens', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256',   name: 'amountOut' },
      { type: 'uint256',   name: 'amountInMax' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapExactETHForTokens', stateMutability: 'payable',
    inputs: [
      { type: 'uint256',   name: 'amountOutMin' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapTokensForExactETH', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256',   name: 'amountOut' },
      { type: 'uint256',   name: 'amountInMax' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapExactTokensForETH', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256',   name: 'amountIn' },
      { type: 'uint256',   name: 'amountOutMin' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapETHForExactTokens', stateMutability: 'payable',
    inputs: [
      { type: 'uint256',   name: 'amountOut' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [{ type: 'uint256[]' }] },
  // Fee-on-transfer variants (USDT-like) — share names with the
  // standard variants but with `SupportingFeeOnTransferTokens` suffix
  // and different selectors.
  { type: 'function', name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256',   name: 'amountIn' },
      { type: 'uint256',   name: 'amountOutMin' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [] },
  { type: 'function', name: 'swapExactETHForTokensSupportingFeeOnTransferTokens', stateMutability: 'payable',
    inputs: [
      { type: 'uint256',   name: 'amountOutMin' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [] },
  { type: 'function', name: 'swapExactTokensForETHSupportingFeeOnTransferTokens', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256',   name: 'amountIn' },
      { type: 'uint256',   name: 'amountOutMin' },
      { type: 'address[]', name: 'path' },
      { type: 'address',   name: 'to' },
      { type: 'uint256',   name: 'deadline' },
    ], outputs: [] },
  { type: 'function', name: 'addLiquidity', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'tokenA' },
      { type: 'address', name: 'tokenB' },
      { type: 'uint256', name: 'amountADesired' },
      { type: 'uint256', name: 'amountBDesired' },
      { type: 'uint256', name: 'amountAMin' },
      { type: 'uint256', name: 'amountBMin' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'deadline' },
    ], outputs: [
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    ] },
  { type: 'function', name: 'addLiquidityETH', stateMutability: 'payable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'uint256', name: 'amountTokenDesired' },
      { type: 'uint256', name: 'amountTokenMin' },
      { type: 'uint256', name: 'amountETHMin' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'deadline' },
    ], outputs: [
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    ] },
  { type: 'function', name: 'removeLiquidity', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'tokenA' },
      { type: 'address', name: 'tokenB' },
      { type: 'uint256', name: 'liquidity' },
      { type: 'uint256', name: 'amountAMin' },
      { type: 'uint256', name: 'amountBMin' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'deadline' },
    ], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'removeLiquidityETH', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'uint256', name: 'liquidity' },
      { type: 'uint256', name: 'amountTokenMin' },
      { type: 'uint256', name: 'amountETHMin' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'deadline' },
    ], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
];

// ─── Uniswap V3 SwapRouter / SwapRouter02 ─────────────────────────────────
// `multicall` is the most common wrapper — V3 dapps batch swap + sweep +
// refund into one call. Decoding multicall just shows the wrapper; the
// inner calls stay raw (decoding nested multicall args is a separate
// project — UI can show "multicall with N inner calls").
const UNISWAP_V3_ABI: Abi = [
  { type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{
      type: 'tuple', name: 'params', components: [
        { type: 'address', name: 'tokenIn' },
        { type: 'address', name: 'tokenOut' },
        { type: 'uint24',  name: 'fee' },
        { type: 'address', name: 'recipient' },
        { type: 'uint256', name: 'deadline' },
        { type: 'uint256', name: 'amountIn' },
        { type: 'uint256', name: 'amountOutMinimum' },
        { type: 'uint160', name: 'sqrtPriceLimitX96' },
      ],
    }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'exactInput', stateMutability: 'payable',
    inputs: [{
      type: 'tuple', name: 'params', components: [
        { type: 'bytes',   name: 'path' },
        { type: 'address', name: 'recipient' },
        { type: 'uint256', name: 'deadline' },
        { type: 'uint256', name: 'amountIn' },
        { type: 'uint256', name: 'amountOutMinimum' },
      ],
    }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'exactOutputSingle', stateMutability: 'payable',
    inputs: [{
      type: 'tuple', name: 'params', components: [
        { type: 'address', name: 'tokenIn' },
        { type: 'address', name: 'tokenOut' },
        { type: 'uint24',  name: 'fee' },
        { type: 'address', name: 'recipient' },
        { type: 'uint256', name: 'deadline' },
        { type: 'uint256', name: 'amountOut' },
        { type: 'uint256', name: 'amountInMaximum' },
        { type: 'uint160', name: 'sqrtPriceLimitX96' },
      ],
    }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'multicall', stateMutability: 'payable',
    inputs: [{ type: 'bytes[]', name: 'data' }],
    outputs: [{ type: 'bytes[]' }] },
  { type: 'function', name: 'multicall', stateMutability: 'payable',
    inputs: [
      { type: 'uint256', name: 'deadline' },
      { type: 'bytes[]', name: 'data' },
    ], outputs: [{ type: 'bytes[]' }] },
  { type: 'function', name: 'refundETH', stateMutability: 'payable',
    inputs: [], outputs: [] },
  { type: 'function', name: 'unwrapWETH9', stateMutability: 'payable',
    inputs: [
      { type: 'uint256', name: 'amountMinimum' },
      { type: 'address', name: 'recipient' },
    ], outputs: [] },
  { type: 'function', name: 'sweepToken', stateMutability: 'payable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'uint256', name: 'amountMinimum' },
      { type: 'address', name: 'recipient' },
    ], outputs: [] },
];

// ─── Uniswap Universal Router ─────────────────────────────────────────────
const UNIVERSAL_ROUTER_ABI: Abi = [
  { type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [
      { type: 'bytes',   name: 'commands' },
      { type: 'bytes[]', name: 'inputs' },
      { type: 'uint256', name: 'deadline' },
    ], outputs: [] },
  { type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [
      { type: 'bytes',   name: 'commands' },
      { type: 'bytes[]', name: 'inputs' },
    ], outputs: [] },
];

// ─── Permit2 (0x00…22D473030F116dDEE9F6B43aC78BA3) ────────────────────────
const PERMIT2_ABI: Abi = [
  { type: 'function', name: 'permit', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'owner' },
      { type: 'tuple',   name: 'permitSingle', components: [
        { type: 'tuple', name: 'details', components: [
          { type: 'address', name: 'token' },
          { type: 'uint160', name: 'amount' },
          { type: 'uint48',  name: 'expiration' },
          { type: 'uint48',  name: 'nonce' },
        ] },
        { type: 'address', name: 'spender' },
        { type: 'uint256', name: 'sigDeadline' },
      ] },
      { type: 'bytes', name: 'signature' },
    ], outputs: [] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint160', name: 'amount' },
      { type: 'address', name: 'token' },
    ], outputs: [] },
  { type: 'function', name: 'lockdown', stateMutability: 'nonpayable',
    inputs: [{
      type: 'tuple[]', name: 'approvals', components: [
        { type: 'address', name: 'token' },
        { type: 'address', name: 'spender' },
      ],
    }], outputs: [] },
  { type: 'function', name: 'invalidateNonces', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'address', name: 'spender' },
      { type: 'uint48',  name: 'newNonce' },
    ], outputs: [] },
];

// ─── Seaport (OpenSea 1.4/1.5/1.6) ────────────────────────────────────────
// Marketplace order fulfilment. Full struct layout is heavy; we keep the
// outermost shape so the user at least sees "fulfillBasicOrder" instead
// of raw hex — they'll trust the price/asset in the order through the
// dapp's UI, not the wallet (sign-confirm shows the offer/consideration
// pieces as nested args).
const SEAPORT_ABI: Abi = [
  { type: 'function', name: 'fulfillBasicOrder', stateMutability: 'payable',
    inputs: [{ type: 'tuple', name: 'parameters', components: [
      { type: 'address', name: 'considerationToken' },
      { type: 'uint256', name: 'considerationIdentifier' },
      { type: 'uint256', name: 'considerationAmount' },
      { type: 'address', name: 'offerer' },
      { type: 'address', name: 'zone' },
      { type: 'address', name: 'offerToken' },
      { type: 'uint256', name: 'offerIdentifier' },
      { type: 'uint256', name: 'offerAmount' },
      { type: 'uint8',   name: 'basicOrderType' },
      { type: 'uint256', name: 'startTime' },
      { type: 'uint256', name: 'endTime' },
      { type: 'bytes32', name: 'zoneHash' },
      { type: 'uint256', name: 'salt' },
      { type: 'bytes32', name: 'offererConduitKey' },
      { type: 'bytes32', name: 'fulfillerConduitKey' },
      { type: 'uint256', name: 'totalOriginalAdditionalRecipients' },
      { type: 'tuple[]', name: 'additionalRecipients', components: [
        { type: 'uint256', name: 'amount' },
        { type: 'address', name: 'recipient' },
      ] },
      { type: 'bytes',   name: 'signature' },
    ] }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable',
    inputs: [{ type: 'tuple[]', name: 'orders', components: [
      { type: 'address', name: 'offerer' },
      { type: 'address', name: 'zone' },
      { type: 'tuple[]', name: 'offer', components: [
        { type: 'uint8',   name: 'itemType' },
        { type: 'address', name: 'token' },
        { type: 'uint256', name: 'identifierOrCriteria' },
        { type: 'uint256', name: 'startAmount' },
        { type: 'uint256', name: 'endAmount' },
      ] },
      { type: 'tuple[]', name: 'consideration', components: [
        { type: 'uint8',   name: 'itemType' },
        { type: 'address', name: 'token' },
        { type: 'uint256', name: 'identifierOrCriteria' },
        { type: 'uint256', name: 'startAmount' },
        { type: 'uint256', name: 'endAmount' },
        { type: 'address', name: 'recipient' },
      ] },
      { type: 'uint8',   name: 'orderType' },
      { type: 'uint256', name: 'startTime' },
      { type: 'uint256', name: 'endTime' },
      { type: 'bytes32', name: 'zoneHash' },
      { type: 'uint256', name: 'salt' },
      { type: 'bytes32', name: 'conduitKey' },
      { type: 'uint256', name: 'counter' },
    ] }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'incrementCounter', stateMutability: 'nonpayable',
    inputs: [], outputs: [{ type: 'uint256' }] },
];

// ─── Multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11) ──────────────
const MULTICALL3_ABI: Abi = [
  { type: 'function', name: 'aggregate', stateMutability: 'payable',
    inputs: [{ type: 'tuple[]', name: 'calls', components: [
      { type: 'address', name: 'target' },
      { type: 'bytes',   name: 'callData' },
    ] }], outputs: [{ type: 'uint256', name: 'blockNumber' }, { type: 'bytes[]', name: 'returnData' }] },
  { type: 'function', name: 'aggregate3', stateMutability: 'payable',
    inputs: [{ type: 'tuple[]', name: 'calls', components: [
      { type: 'address', name: 'target' },
      { type: 'bool',    name: 'allowFailure' },
      { type: 'bytes',   name: 'callData' },
    ] }], outputs: [{ type: 'tuple[]', name: 'returnData', components: [
      { type: 'bool',  name: 'success' },
      { type: 'bytes', name: 'returnData' },
    ] }] },
  { type: 'function', name: 'tryAggregate', stateMutability: 'payable',
    inputs: [
      { type: 'bool', name: 'requireSuccess' },
      { type: 'tuple[]', name: 'calls', components: [
        { type: 'address', name: 'target' },
        { type: 'bytes',   name: 'callData' },
      ] },
    ], outputs: [{ type: 'tuple[]', name: 'returnData', components: [
      { type: 'bool',  name: 'success' },
      { type: 'bytes', name: 'returnData' },
    ] }] },
];

// ─── Common DeFi staking / claim / mint patterns ──────────────────────────
// These are NOT selector-canonical (any contract can have a `claim()`
// function with arbitrary semantics) — they're best-guess labels that
// help the user at least see "claim" rather than "0x4e71d92d". Args
// are decoded; semantic meaning is for the user to know from the
// dapp's UI.
const COMMON_PATTERNS_ABI: Abi = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable',
    inputs: [], outputs: [] },
  { type: 'function', name: 'mint', stateMutability: 'payable',
    inputs: [{ type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'mint', stateMutability: 'payable',
    inputs: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'amount' },
    ], outputs: [] },
  { type: 'function', name: 'burn', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'stake', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'unstake', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'harvest', stateMutability: 'nonpayable',
    inputs: [], outputs: [] },
  { type: 'function', name: 'exit', stateMutability: 'nonpayable',
    inputs: [], outputs: [] },
];

/** The combined ABI used by `decodeTxData` for the local-table path.
 *  Order matters when names overlap (e.g. `mint(uint256)` vs
 *  `mint(address,uint256)`) — viem matches by selector, not name, so
 *  there's no order-sensitivity in practice. */
export const SELECTOR_TABLE_ABI: Abi = [
  ...ERC20_EXTRA_ABI,
  ...ERC721_ABI,
  ...ERC1155_ABI,
  ...UNISWAP_V2_ABI,
  ...UNISWAP_V3_ABI,
  ...UNIVERSAL_ROUTER_ABI,
  ...PERMIT2_ABI,
  ...SEAPORT_ABI,
  ...MULTICALL3_ABI,
  ...COMMON_PATTERNS_ABI,
];
