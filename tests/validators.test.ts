// Unit tests for the pure validators in src/lib/validators.ts.
// Run with: `bun test` from the wallet/ directory.
//
// Coverage targets:
//   • All six EIP-712 malformed cases land in -32602
//   • EIP712Domain canonical four-rule check (names / order / types / parity)
//   • Permit-shaped happy path passes
//   • eth_sendTransaction params (decimal value / non-hex / bad address /
//     unknown tx.type 0x5+) all rejected
//   • unpackTypedDataParams handles v1 / v3-v4 / undefined cleanly

import { describe, expect, test } from 'bun:test';
import {
  validateTypedDataSchema,
  validateSendTransactionParams,
  validateWatchAssetParams,
  unpackTypedDataParams,
} from '../src/lib/validators';

// ─── Fixtures ─────────────────────────────────────────────────────────────

type TypedDataFixture = {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
};

/** Canonical ERC-2612 Permit typed data — used as a baseline that should
 *  pass every check. Mutate one field per test to isolate the failure. */
const PERMIT_OK: TypedDataFixture = {
  types: {
    EIP712Domain: [
      { name: 'name',              type: 'string'  },
      { name: 'version',           type: 'string'  },
      { name: 'chainId',           type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: 'Permit',
  domain: {
    name: 'USDC',
    version: '2',
    chainId: 1,
    verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  message: {
    owner:    '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
    spender:  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    value:    '1000000',
    nonce:    '0',
    deadline: '999999999',
  },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ─── validateTypedDataSchema ──────────────────────────────────────────────

describe('validateTypedDataSchema', () => {
  test('canonical Permit passes', () => {
    expect(validateTypedDataSchema(PERMIT_OK)).toBeNull();
  });

  test('accepts JSON-stringified payload (not just objects)', () => {
    expect(validateTypedDataSchema(JSON.stringify(PERMIT_OK))).toBeNull();
  });

  test('rejects un-parseable JSON string', () => {
    expect(validateTypedDataSchema('{not-json}')).toMatch(/not valid JSON/);
  });

  test('rejects non-object root (array / null / primitive)', () => {
    expect(validateTypedDataSchema([])).toMatch(/typed data must be an object/);
    expect(validateTypedDataSchema(null)).toMatch(/typed data must be an object/);
    expect(validateTypedDataSchema(42)).toMatch(/typed data must be an object/);
  });

  // ── 6 malformed cases ──

  test('[NO PRIMARY TYPE] missing primaryType', () => {
    const bad = clone(PERMIT_OK) as Record<string, unknown>;
    delete bad.primaryType;
    expect(validateTypedDataSchema(bad)).toMatch(/primaryType is missing/);
  });

  test('[NO PRIMARY TYPE] non-string primaryType', () => {
    const bad: Record<string, unknown> = clone(PERMIT_OK);
    bad.primaryType = 42;
    expect(validateTypedDataSchema(bad)).toMatch(/primaryType is missing/);
  });

  test('[INVALID PRIMARY TYPE] points to undeclared struct', () => {
    const bad: Record<string, unknown> = clone(PERMIT_OK);
    bad.primaryType = 'Non-Existent';
    expect(validateTypedDataSchema(bad)).toMatch(/"Non-Existent" is not declared/);
  });

  test('[INVALID TYPE] field type uint999', () => {
    const bad = clone(PERMIT_OK);
    bad.types.Permit[2]!.type = 'uint999';
    const err = validateTypedDataSchema(bad);
    expect(err).toMatch(/invalid type "uint999"/);
  });

  test('[INVALID TYPE] field type uint7 (non-multiple of 8)', () => {
    const bad = clone(PERMIT_OK);
    bad.types.Permit[2]!.type = 'uint7';
    expect(validateTypedDataSchema(bad)).toMatch(/invalid type "uint7"/);
  });

  test('[INVALID TYPE] bare uint without size', () => {
    const bad = clone(PERMIT_OK);
    bad.types.Permit[2]!.type = 'uint';
    expect(validateTypedDataSchema(bad)).toMatch(/invalid type "uint"/);
  });

  test('[INVALID TYPE] valid array suffix accepted (Person[])', () => {
    const ok = {
      types: {
        EIP712Domain: PERMIT_OK.types.EIP712Domain,
        Person: [{ name: 'name', type: 'string' }],
        Group:  [{ name: 'members', type: 'Person[]' }],
      },
      primaryType: 'Group',
      domain: PERMIT_OK.domain,
      message: { members: [{ name: 'Alice' }] },
    };
    expect(validateTypedDataSchema(ok)).toBeNull();
  });

  test('[EMPTY DOMAIN] no replay binding', () => {
    const bad = clone(PERMIT_OK);
    bad.domain = { name: 'X', version: '1' };
    bad.types.EIP712Domain = [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
    ];
    expect(validateTypedDataSchema(bad)).toMatch(/domain has no chainId/);
  });

  test('[EMPTY DOMAIN] domain missing entirely', () => {
    const bad: Record<string, unknown> = clone(PERMIT_OK);
    delete bad.domain;
    expect(validateTypedDataSchema(bad)).toMatch(/domain is missing/);
  });

  test('[INVALID VERIFYING CONTRACT] not a 20-byte address', () => {
    const bad = clone(PERMIT_OK);
    bad.domain.verifyingContract = 'not-an-address';
    expect(validateTypedDataSchema(bad)).toMatch(/verifyingContract is not a valid 20-byte address/);
  });

  test('[INVALID VERIFYING CONTRACT] short hex', () => {
    const bad = clone(PERMIT_OK);
    bad.domain.verifyingContract = '0x123';
    expect(validateTypedDataSchema(bad)).toMatch(/verifyingContract is not a valid 20-byte address/);
  });

  test('[EXTRA DATA NOT TYPED] message has key not declared', () => {
    const bad: typeof PERMIT_OK = clone(PERMIT_OK);
    (bad.message as Record<string, unknown>).secretField = 'phishing-decoy';
    expect(validateTypedDataSchema(bad)).toMatch(/"secretField" is not declared.*decoy field/);
  });

  test('[EXTRA DATA NOT TYPED] nested object extra', () => {
    const bad = {
      types: {
        EIP712Domain: PERMIT_OK.types.EIP712Domain,
        Person: [{ name: 'name', type: 'string' }],
        Mail:   [{ name: 'from', type: 'Person' }],
      },
      primaryType: 'Mail',
      domain: PERMIT_OK.domain,
      message: { from: { name: 'Cow', secretRank: 'admin' } },
    };
    expect(validateTypedDataSchema(bad)).toMatch(/"from\.secretRank" is not declared/);
  });

  // ── EIP712Domain canonical four-rule ──

  test('EIP712Domain rejects unknown field name', () => {
    const bad = clone(PERMIT_OK);
    bad.types.EIP712Domain.push({ name: 'foo', type: 'string' });
    bad.domain = { ...bad.domain, foo: 'x' };
    expect(validateTypedDataSchema(bad)).toMatch(/EIP712Domain has unknown field "foo"/);
  });

  test('EIP712Domain rejects out-of-order fields', () => {
    const bad = clone(PERMIT_OK);
    bad.types.EIP712Domain = [
      { name: 'chainId', type: 'uint256' },
      { name: 'name',    type: 'string'  },
    ];
    bad.domain = { name: 'X', chainId: 1 };
    expect(validateTypedDataSchema(bad)).toMatch(/out of canonical order/);
  });

  test('EIP712Domain rejects wrong type for chainId', () => {
    const bad = clone(PERMIT_OK);
    bad.types.EIP712Domain[2]!.type = 'uint128';
    expect(validateTypedDataSchema(bad)).toMatch(/EIP712Domain\.chainId must be uint256/);
  });

  test('EIP712Domain key parity — extra key in domain object', () => {
    const bad: typeof PERMIT_OK = clone(PERMIT_OK);
    (bad.domain as Record<string, unknown>).salt = '0x' + '00'.repeat(32);
    expect(validateTypedDataSchema(bad)).toMatch(/"salt" not declared in types\.EIP712Domain.*decoy field/);
  });

  test('EIP712Domain key parity — missing key in domain object', () => {
    const bad: Record<string, unknown> = clone(PERMIT_OK);
    delete (bad.domain as Record<string, unknown>).version;
    expect(validateTypedDataSchema(bad)).toMatch(/missing "version" which is declared in types\.EIP712Domain/);
  });

  test('EIP712Domain missing types entry', () => {
    const bad: Record<string, unknown> = clone(PERMIT_OK);
    delete (bad.types as Record<string, unknown>).EIP712Domain;
    expect(validateTypedDataSchema(bad)).toMatch(/EIP712Domain is missing/);
  });
});

// ─── validateSendTransactionParams ────────────────────────────────────────

describe('validateSendTransactionParams', () => {
  const TX_OK = {
    from:  '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
    to:    '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    value: '0x16345785d8a0000',
    data:  '0xabcdef',
  };

  test('canonical tx passes', () => {
    expect(validateSendTransactionParams([TX_OK])).toBeNull();
  });

  test('rejects empty / non-array params', () => {
    expect(validateSendTransactionParams(undefined)).toMatch(/non-empty array/);
    expect(validateSendTransactionParams([])).toMatch(/non-empty array/);
    expect(validateSendTransactionParams({} as unknown)).toMatch(/non-empty array/);
  });

  test('rejects non-object tx', () => {
    expect(validateSendTransactionParams(['not-a-tx'])).toMatch(/must be a tx object/);
  });

  test('allows missing to (contract deploy)', () => {
    const tx = { ...TX_OK } as Record<string, unknown>;
    delete tx.to;
    expect(validateSendTransactionParams([tx])).toBeNull();
  });

  test('rejects malformed to', () => {
    expect(validateSendTransactionParams([{ ...TX_OK, to: 'not-an-address' }])).toMatch(/to is not a valid 20-byte address/);
    expect(validateSendTransactionParams([{ ...TX_OK, to: '0x123' }])).toMatch(/to is not a valid 20-byte address/);
  });

  test('rejects decimal value (common dapp bug)', () => {
    expect(validateSendTransactionParams([{ ...TX_OK, value: '0.01' }])).toMatch(/tx\.value must be hex-prefixed/);
  });

  test('rejects integer value without 0x prefix', () => {
    expect(validateSendTransactionParams([{ ...TX_OK, value: '10000000000000000' }])).toMatch(/tx\.value must be hex-prefixed/);
  });

  test('rejects malformed gas / gasPrice / maxFeePerGas', () => {
    expect(validateSendTransactionParams([{ ...TX_OK, gas: 21000 }])).toMatch(/tx\.gas must be hex-prefixed/);
    expect(validateSendTransactionParams([{ ...TX_OK, maxFeePerGas: 'not-hex' }])).toMatch(/tx\.maxFeePerGas must be hex-prefixed/);
  });

  test('rejects malformed data', () => {
    expect(validateSendTransactionParams([{ ...TX_OK, data: 'plain-text' }])).toMatch(/tx\.data must be hex-prefixed/);
  });

  test('accepts known tx.type 0x0..0x4', () => {
    for (const t of ['0x0', '0x1', '0x2', '0x3', '0x4']) {
      expect(validateSendTransactionParams([{ ...TX_OK, type: t }])).toBeNull();
    }
  });

  test('rejects unknown tx.type 0x5+', () => {
    expect(validateSendTransactionParams([{ ...TX_OK, type: '0x5' }])).toMatch(/not a known EIP-2718 envelope/);
    expect(validateSendTransactionParams([{ ...TX_OK, type: '0xff' }])).toMatch(/not a known EIP-2718 envelope/);
  });

  test('accepts undefined / null optional fields', () => {
    expect(validateSendTransactionParams([{ to: TX_OK.to }])).toBeNull();
    expect(validateSendTransactionParams([{ to: TX_OK.to, value: undefined, data: null, type: null }])).toBeNull();
  });
});

// ─── validateWatchAssetParams (EIP-747) ───────────────────────────────────

describe('validateWatchAssetParams', () => {
  const OK = {
    type: 'ERC20',
    options: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      image: 'https://example.com/usdc.png',
    },
  };

  test('canonical bare-object form passes', () => {
    expect(validateWatchAssetParams(OK)).toBeNull();
  });

  test('JSON-RPC array-wrapped form also passes', () => {
    expect(validateWatchAssetParams([OK])).toBeNull();
  });

  test('accepts ERC721 / ERC1155 when tokenId provided', () => {
    expect(validateWatchAssetParams({
      type: 'ERC721',
      options: { address: '0x1111111111111111111111111111111111111111', tokenId: '42' },
    })).toBeNull();
    expect(validateWatchAssetParams({
      type: 'ERC1155',
      options: { address: '0x1111111111111111111111111111111111111111', tokenId: '0x2a' },
    })).toBeNull();
  });

  test('rejects ERC721 / ERC1155 without tokenId', () => {
    expect(validateWatchAssetParams({
      type: 'ERC721',
      options: { address: '0x1111111111111111111111111111111111111111' },
    })).toMatch(/tokenId is required/);
    expect(validateWatchAssetParams({
      type: 'ERC1155',
      options: { address: '0x1111111111111111111111111111111111111111' },
    })).toMatch(/tokenId is required/);
  });

  test('rejects malformed tokenId', () => {
    expect(validateWatchAssetParams({
      type: 'ERC721',
      options: { address: '0x1111111111111111111111111111111111111111', tokenId: 'abc' },
    })).toMatch(/tokenId must be/);
    expect(validateWatchAssetParams({
      type: 'ERC721',
      options: { address: '0x1111111111111111111111111111111111111111', tokenId: -1 },
    })).toMatch(/tokenId is required/);
  });

  test('rejects unknown types', () => {
    expect(validateWatchAssetParams({ ...OK, type: 'ERC777' })).toMatch(/unsupported asset type/);
    expect(validateWatchAssetParams({ ...OK, type: 'NFT' })).toMatch(/unsupported asset type/);
  });

  test('rejects missing options', () => {
    expect(validateWatchAssetParams({ type: 'ERC20' })).toMatch(/options must be an object/);
  });

  test('rejects malformed contract address', () => {
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, address: 'not-an-addr' } }))
      .toMatch(/address is not a valid 20-byte address/);
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, address: '0x123' } }))
      .toMatch(/address is not a valid 20-byte address/);
  });

  test('symbol length: empty / too long rejected (EIP-747 says 1–11 chars)', () => {
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, symbol: '' } }))
      .toMatch(/symbol must be 1–11 chars/);
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, symbol: 'A'.repeat(12) } }))
      .toMatch(/symbol must be 1–11 chars/);
  });

  test('symbol omitted is allowed (we re-fetch from chain)', () => {
    const noSym = { type: 'ERC20', options: { address: OK.options.address } };
    expect(validateWatchAssetParams(noSym)).toBeNull();
  });

  test('decimals: out-of-range rejected', () => {
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, decimals: -1 } }))
      .toMatch(/decimals must be an integer 0–36/);
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, decimals: 37 } }))
      .toMatch(/decimals must be an integer 0–36/);
    expect(validateWatchAssetParams({ ...OK, options: { ...OK.options, decimals: 1.5 } }))
      .toMatch(/decimals must be an integer 0–36/);
  });

  test('rejects empty / null params', () => {
    expect(validateWatchAssetParams(undefined)).toMatch(/must be an object/);
    expect(validateWatchAssetParams(null)).toMatch(/must be an object/);
  });
});

// ─── unpackTypedDataParams ────────────────────────────────────────────────

describe('unpackTypedDataParams', () => {
  const ADDR = '0xdd221fA2aC8c384aD618B0D7aa54672BFadBefCD';

  test('v3/v4 shape: [signer, dataObject]', () => {
    const data = { primaryType: 'Permit', message: {} };
    const r = unpackTypedDataParams([ADDR, data]);
    expect(r.signer).toBe(ADDR);
    expect(r.data).toBe(data);
  });

  test('v3/v4 shape: [signer, dataJsonString]', () => {
    const data = '{"primaryType":"Permit"}';
    const r = unpackTypedDataParams([ADDR, data]);
    expect(r.signer).toBe(ADDR);
    expect(r.data).toBe(data);
  });

  test('v1 legacy shape: [dataArray, signer]', () => {
    const data = [{ name: 'Message', type: 'string', value: 'Hi' }];
    const r = unpackTypedDataParams([data, ADDR]);
    expect(r.signer).toBe(ADDR);
    expect(r.data).toBe(data);
  });

  test('returns undefined signer when no slot looks like an address', () => {
    const r = unpackTypedDataParams([{}, {}]);
    expect(r.signer).toBeUndefined();
  });

  test('handles empty / malformed input gracefully (no throw)', () => {
    expect(() => unpackTypedDataParams(undefined)).not.toThrow();
    expect(() => unpackTypedDataParams([])).not.toThrow();
    expect(() => unpackTypedDataParams(null)).not.toThrow();
  });
});
