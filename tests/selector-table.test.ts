// Bundled-selector-table coverage tests. Encodes calldata using each
// protocol's real ABI, then verifies decodeTxData recognises it by
// selector and returns a {name, args} pair the sign-confirm UI can
// render. Catches regressions where someone removes / renames an entry
// in selector-table.ts and inadvertently drops protocol coverage.

import { describe, expect, test } from 'bun:test';
import { encodeFunctionData, type Abi } from 'viem';
import { decodeTxData, decodeTxDataWithAbi } from '../src/lib/decoders';
import { SELECTOR_TABLE_ABI } from '../src/lib/selector-table';

const ADDR = '0x1111111111111111111111111111111111111111' as const;
const ADDR2 = '0x2222222222222222222222222222222222222222' as const;
const ADDR3 = '0x3333333333333333333333333333333333333333' as const;

/** Helper: encode against a given function in SELECTOR_TABLE_ABI, then
 *  round-trip through decodeTxData. Returns the decoded `known` payload
 *  or fails the test if decode returned `unknown` / `native`. */
function roundTrip(functionName: string, args: readonly unknown[], abi: Abi = SELECTOR_TABLE_ABI): {
  name: string; args: readonly unknown[];
} {
  // viem's encodeFunctionData picks the right overload by matching the
  // provided args against each entry with that name. If we have two
  // overloads of the same name (e.g. `mint`), viem picks the one whose
  // input types match the args.
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const r = decodeTxData(data);
  if (r.kind !== 'known') {
    throw new Error(`decodeTxData returned ${r.kind} for ${functionName}; data=${data}`);
  }
  return { name: r.name, args: r.args };
}

describe('SELECTOR_TABLE_ABI — ERC-721', () => {
  test('safeTransferFrom (no data)', () => {
    const r = roundTrip('safeTransferFrom', [ADDR, ADDR2, 42n]);
    expect(r.name).toBe('safeTransferFrom');
    expect(r.args.length).toBe(3);
    expect(r.args[2]).toBe(42n);
  });

  test('safeTransferFrom (with data) — different selector from no-data overload', () => {
    const r = roundTrip('safeTransferFrom', [ADDR, ADDR2, 42n, '0xdeadbeef']);
    expect(r.name).toBe('safeTransferFrom');
    expect(r.args.length).toBe(4);
  });

  test('setApprovalForAll', () => {
    const r = roundTrip('setApprovalForAll', [ADDR, true]);
    expect(r.name).toBe('setApprovalForAll');
    expect(r.args[1]).toBe(true);
  });
});

describe('SELECTOR_TABLE_ABI — ERC-1155', () => {
  test('safeBatchTransferFrom', () => {
    const r = roundTrip('safeBatchTransferFrom', [
      ADDR, ADDR2, [1n, 2n], [10n, 20n], '0x',
    ]);
    expect(r.name).toBe('safeBatchTransferFrom');
    expect(r.args.length).toBe(5);
  });
});

describe('SELECTOR_TABLE_ABI — Uniswap V2', () => {
  test('swapExactTokensForTokens (the canonical V2 swap)', () => {
    const r = roundTrip('swapExactTokensForTokens', [
      1000n, 990n, [ADDR, ADDR2], ADDR3, 9999999999n,
    ]);
    expect(r.name).toBe('swapExactTokensForTokens');
    expect((r.args[2] as readonly string[])[0]).toBe(ADDR);
  });

  test('swapExactETHForTokens', () => {
    const r = roundTrip('swapExactETHForTokens', [
      990n, [ADDR, ADDR2], ADDR3, 9999999999n,
    ]);
    expect(r.name).toBe('swapExactETHForTokens');
  });

  test('fee-on-transfer variant has distinct selector', () => {
    const r = roundTrip('swapExactTokensForTokensSupportingFeeOnTransferTokens', [
      1000n, 990n, [ADDR, ADDR2], ADDR3, 9999999999n,
    ]);
    expect(r.name).toBe('swapExactTokensForTokensSupportingFeeOnTransferTokens');
  });

  test('addLiquidity', () => {
    const r = roundTrip('addLiquidity', [
      ADDR, ADDR2, 1000n, 1000n, 990n, 990n, ADDR3, 9999999999n,
    ]);
    expect(r.name).toBe('addLiquidity');
    expect(r.args.length).toBe(8);
  });
});

describe('SELECTOR_TABLE_ABI — Uniswap V3', () => {
  test('exactInputSingle (tuple params)', () => {
    const params = {
      tokenIn: ADDR,
      tokenOut: ADDR2,
      fee: 3000,
      recipient: ADDR3,
      deadline: 9999999999n,
      amountIn: 1000n,
      amountOutMinimum: 990n,
      sqrtPriceLimitX96: 0n,
    };
    const r = roundTrip('exactInputSingle', [params]);
    expect(r.name).toBe('exactInputSingle');
    // First arg is the decoded tuple as an object.
    expect((r.args[0] as { tokenIn: string }).tokenIn).toBe(ADDR);
  });

  test('multicall(bytes[]) and multicall(uint256,bytes[]) — different selectors', () => {
    const r1 = roundTrip('multicall', [['0xaabbccdd' as `0x${string}`]]);
    expect(r1.name).toBe('multicall');
    expect(r1.args.length).toBe(1);

    const r2 = roundTrip('multicall', [9999999999n, ['0xaabbccdd' as `0x${string}`]]);
    expect(r2.name).toBe('multicall');
    expect(r2.args.length).toBe(2);
  });

  test('unwrapWETH9', () => {
    const r = roundTrip('unwrapWETH9', [100n, ADDR]);
    expect(r.name).toBe('unwrapWETH9');
  });
});

describe('SELECTOR_TABLE_ABI — Universal Router', () => {
  test('execute(commands, inputs, deadline) — 3-arg overload', () => {
    const r = roundTrip('execute', [
      '0x08' as `0x${string}`,
      ['0xdeadbeef' as `0x${string}`],
      9999999999n,
    ]);
    expect(r.name).toBe('execute');
    expect(r.args.length).toBe(3);
  });

  test('execute(commands, inputs) — 2-arg overload', () => {
    const r = roundTrip('execute', [
      '0x08' as `0x${string}`,
      ['0xdeadbeef' as `0x${string}`],
    ]);
    expect(r.name).toBe('execute');
    expect(r.args.length).toBe(2);
  });
});

describe('SELECTOR_TABLE_ABI — Permit2', () => {
  test('transferFrom (Permit2 4-arg variant, not ERC-20)', () => {
    // ERC-20 transferFrom is (from,to,uint256). Permit2's is
    // (from,to,uint160,token). Different selector — must decode to
    // the Permit2 shape with 4 args.
    const r = roundTrip('transferFrom', [ADDR, ADDR2, 1000n, ADDR3]);
    expect(r.name).toBe('transferFrom');
    expect(r.args.length).toBe(4);
    // 4th arg is the token address — distinguishes Permit2 from ERC-20.
    expect(r.args[3]).toBe(ADDR3);
  });

  test('lockdown', () => {
    const r = roundTrip('lockdown', [[{ token: ADDR, spender: ADDR2 }]]);
    expect(r.name).toBe('lockdown');
  });
});

describe('SELECTOR_TABLE_ABI — Multicall3', () => {
  test('aggregate3', () => {
    const r = roundTrip('aggregate3', [[
      { target: ADDR, allowFailure: true, callData: '0xaabbccdd' as `0x${string}` },
    ]]);
    expect(r.name).toBe('aggregate3');
  });
});

describe('SELECTOR_TABLE_ABI — common patterns', () => {
  test('claim() no-arg', () => {
    const r = roundTrip('claim', []);
    expect(r.name).toBe('claim');
  });

  test('mint(uint256) — single-arg overload', () => {
    const r = roundTrip('mint', [100n]);
    expect(r.name).toBe('mint');
    expect(r.args.length).toBe(1);
  });

  test('mint(address,uint256) — two-arg overload', () => {
    const r = roundTrip('mint', [ADDR, 100n]);
    expect(r.name).toBe('mint');
    expect(r.args.length).toBe(2);
  });

  test('stake / unstake / harvest / exit / burn', () => {
    expect(roundTrip('stake', [100n]).name).toBe('stake');
    expect(roundTrip('unstake', [100n]).name).toBe('unstake');
    expect(roundTrip('harvest', []).name).toBe('harvest');
    expect(roundTrip('exit', []).name).toBe('exit');
    expect(roundTrip('burn', [100n]).name).toBe('burn');
  });
});

describe('decodeTxDataWithAbi (Sourcify fallback)', () => {
  // Caller passes a Sourcify-fetched ABI. Decoder uses it instead of
  // (or in addition to) the bundled table.
  const CUSTOM_ABI: Abi = [
    { type: 'function', name: 'customDappFunction', stateMutability: 'nonpayable',
      inputs: [{ type: 'uint256', name: 'magic' }, { type: 'address', name: 'who' }],
      outputs: [] },
  ];

  test('decodes a non-bundled function via passed ABI', () => {
    const data = encodeFunctionData({
      abi: CUSTOM_ABI,
      functionName: 'customDappFunction',
      args: [42n, ADDR],
    });
    const r = decodeTxDataWithAbi(data, CUSTOM_ABI);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') {
      expect(r.name).toBe('customDappFunction');
      expect(r.args[0]).toBe(42n);
    }
  });

  test('empty / undefined data → native', () => {
    expect(decodeTxDataWithAbi(undefined, CUSTOM_ABI).kind).toBe('native');
    expect(decodeTxDataWithAbi('0x', CUSTOM_ABI).kind).toBe('native');
  });

  test('missing ABI → unknown', () => {
    const r = decodeTxDataWithAbi('0xaabbccdd00000000', undefined);
    expect(r.kind).toBe('unknown');
  });

  test('ABI miss → unknown (selector not in passed ABI)', () => {
    const r = decodeTxDataWithAbi('0xdeadbeef00000000', CUSTOM_ABI);
    expect(r.kind).toBe('unknown');
  });
});

describe('unknown selectors stay unknown', () => {
  test('random bytes that match no bundled function', () => {
    // 0xdeadbeef + 32 bytes of zeros — selector almost certainly
    // doesn't collide with anything in the bundled table.
    const r = decodeTxData('0xdeadbeef' + '00'.repeat(32));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.selector).toBe('0xdeadbeef');
  });
});
