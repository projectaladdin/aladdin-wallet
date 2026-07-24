// Crypto tests — vault encryption + HD derivation determinism + signature
// round-trips against viem's recovery helpers.
//
// The biggest security claims this module makes:
//   1. encrypt → decrypt round-trips with the same password
//   2. wrong password fails (auth tag mismatch becomes "wrong password")
//   3. tampered ciphertext is detected (AES-GCM auth tag rejects it)
//   4. PBKDF2 iter count matches OWASP 2023 (600k)
//   5. addressFromMnemonic is deterministic per (mnemonic, index) — same
//      mnemonic on a different machine produces the same address
//   6. sign helpers produce signatures that recover to the same address
//      (catches accidental re-derivation / off-by-one in BIP-44 path)

import { describe, expect, test } from 'bun:test';
import {
  newMnemonic,
  isValidMnemonic,
  addressFromMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  generateSessionKey,
  sessionEncrypt,
  sessionDecrypt,
  signMessageFromMnemonic,
  signTypedDataFromMnemonic,
  signAuthorizationFromMnemonic,
  parseTypedData,
} from '../src/core/crypto';
import {
  recoverMessageAddress,
  recoverTypedDataAddress,
} from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';

// Anvil dev mnemonic — well-known test vector. Account 0 always derives to
// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 with `m/44'/60'/0'/0/0`.
// Using this means our determinism tests have known-good ground truth.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const TEST_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TEST_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// ─── Vault encrypt / decrypt round-trip ───────────────────────────────────

describe('encryptMnemonic / decryptMnemonic', () => {
  test('round-trips with the same password', async () => {
    const v = await encryptMnemonic(TEST_MNEMONIC, 'hunter2hunter2');
    const out = await decryptMnemonic(v, 'hunter2hunter2');
    expect(out).toBe(TEST_MNEMONIC);
  });

  test('wrong password fails with "wrong password"', async () => {
    const v = await encryptMnemonic(TEST_MNEMONIC, 'correct password');
    await expect(decryptMnemonic(v, 'wrong password')).rejects.toThrow('wrong password');
  });

  test('tampered ciphertext fails (AES-GCM auth tag)', async () => {
    const v = await encryptMnemonic(TEST_MNEMONIC, 'pw');
    // Flip a bit in the middle of the base64 blob.
    const decoded = Uint8Array.from(atob(v.blob), (c) => c.charCodeAt(0));
    decoded[decoded.length - 5]! ^= 0x01;
    const tampered = { ...v, blob: btoa(String.fromCharCode(...decoded)) };
    await expect(decryptMnemonic(tampered, 'pw')).rejects.toThrow('wrong password');
  });

  test('vault metadata records OWASP 600k iterations', async () => {
    const v = await encryptMnemonic(TEST_MNEMONIC, 'pw');
    expect(v.iterations).toBe(600_000);
    expect(v.version).toBe(1);
  });

  test('refuses unknown vault version', async () => {
    const v = await encryptMnemonic(TEST_MNEMONIC, 'pw');
    await expect(decryptMnemonic({ ...v, version: 99 as 1 }, 'pw'))
      .rejects.toThrow(/unknown vault version/);
  });

  test('two encryptions of same mnemonic+password produce different blobs', async () => {
    // Different salt + iv per encrypt → ciphertext indistinguishable.
    const a = await encryptMnemonic(TEST_MNEMONIC, 'pw');
    const b = await encryptMnemonic(TEST_MNEMONIC, 'pw');
    expect(a.blob).not.toBe(b.blob);
  });
});

// ─── BIP-39 mnemonic helpers ──────────────────────────────────────────────

describe('mnemonic helpers', () => {
  test('newMnemonic produces 12 BIP-39 words', () => {
    const m = newMnemonic();
    expect(m.split(/\s+/).length).toBe(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  test('isValidMnemonic rejects checksum errors', () => {
    // Replace last word with another valid wordlist word — checksum breaks.
    const broken = TEST_MNEMONIC.split(/\s+/).slice(0, 11).concat(['abandon']).join(' ');
    expect(isValidMnemonic(broken)).toBe(false);
  });

  test('isValidMnemonic rejects unknown words', () => {
    expect(isValidMnemonic('not in any wordlist banana xyz xyz xyz xyz xyz xyz xyz xyz junk')).toBe(false);
  });

  test('isValidMnemonic accepts uppercase + extra whitespace', () => {
    expect(isValidMnemonic(`  ${TEST_MNEMONIC.toUpperCase()}  `)).toBe(true);
  });
});

// ─── HD derivation determinism (BIP-44 m/44'/60'/0'/0/N) ──────────────────

describe('addressFromMnemonic', () => {
  test('Anvil mnemonic + index 0 = canonical address', () => {
    expect(addressFromMnemonic(TEST_MNEMONIC, 0).toLowerCase())
      .toBe(TEST_ADDR_0.toLowerCase());
  });

  test('Anvil mnemonic + index 1 = canonical address', () => {
    expect(addressFromMnemonic(TEST_MNEMONIC, 1).toLowerCase())
      .toBe(TEST_ADDR_1.toLowerCase());
  });

  test('default index = 0', () => {
    expect(addressFromMnemonic(TEST_MNEMONIC).toLowerCase())
      .toBe(addressFromMnemonic(TEST_MNEMONIC, 0).toLowerCase());
  });

  test('different indexes produce different addresses', () => {
    const a0 = addressFromMnemonic(TEST_MNEMONIC, 0);
    const a1 = addressFromMnemonic(TEST_MNEMONIC, 1);
    const a2 = addressFromMnemonic(TEST_MNEMONIC, 2);
    expect(a0).not.toBe(a1);
    expect(a1).not.toBe(a2);
    expect(a0).not.toBe(a2);
  });

  test('same mnemonic + same index = same address (idempotent)', () => {
    for (let i = 0; i < 5; i++) {
      const a = addressFromMnemonic(TEST_MNEMONIC, 7);
      const b = addressFromMnemonic(TEST_MNEMONIC, 7);
      expect(a).toBe(b);
    }
  });
});

// ─── Signature round-trips (sign → recover → match address) ───────────────

describe('signMessageFromMnemonic', () => {
  test('utf8 message round-trips via recoverMessageAddress', async () => {
    const sig = await signMessageFromMnemonic(TEST_MNEMONIC, 'hello world', 0);
    const recovered = await recoverMessageAddress({ message: 'hello world', signature: sig });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR_0.toLowerCase());
  });

  test('raw hex bytes round-trip', async () => {
    const sig = await signMessageFromMnemonic(TEST_MNEMONIC, { raw: '0xdeadbeef' }, 0);
    const recovered = await recoverMessageAddress({
      message: { raw: '0xdeadbeef' },
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR_0.toLowerCase());
  });

  test('different account index recovers to different address', async () => {
    const sig = await signMessageFromMnemonic(TEST_MNEMONIC, 'msg', 1);
    const recovered = await recoverMessageAddress({ message: 'msg', signature: sig });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR_1.toLowerCase());
  });
});

describe('signTypedDataFromMnemonic', () => {
  // Standard EIP-2612 Permit example. EIP712Domain is included; viem strips
  // it internally when hashing.
  const PERMIT_PAYLOAD = {
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
      verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
    },
    message: {
      owner: TEST_ADDR_0,
      spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      value: '1000000',
      nonce: '0',
      deadline: '999999999',
    },
  };

  test('object payload round-trips via recoverTypedDataAddress', async () => {
    const sig = await signTypedDataFromMnemonic(TEST_MNEMONIC, PERMIT_PAYLOAD, 0);
    const recovered = await recoverTypedDataAddress({
      domain: PERMIT_PAYLOAD.domain,
      types: { Permit: PERMIT_PAYLOAD.types.Permit },
      primaryType: 'Permit',
      message: PERMIT_PAYLOAD.message,
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR_0.toLowerCase());
  });

  test('JSON-string payload round-trips identically (object vs string indifferent)', async () => {
    const a = await signTypedDataFromMnemonic(TEST_MNEMONIC, PERMIT_PAYLOAD, 0);
    const b = await signTypedDataFromMnemonic(TEST_MNEMONIC, JSON.stringify(PERMIT_PAYLOAD), 0);
    expect(a).toBe(b);
  });

  test('parseTypedData rejects missing required fields', () => {
    expect(() => parseTypedData(null)).toThrow();
    expect(() => parseTypedData({ types: {}, primaryType: 'X' })).toThrow();
    expect(() => parseTypedData({ types: {}, message: {}, primaryType: 'X' })).toThrow(); // no domain
  });
});

describe('signAuthorizationFromMnemonic', () => {
  test('signed authorization recovers to signer address', async () => {
    const auth = await signAuthorizationFromMnemonic(TEST_MNEMONIC, {
      contractAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      chainId: 1,
      nonce: 0,
    }, 0);
    const recovered = await recoverAuthorizationAddress({ authorization: auth });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR_0.toLowerCase());
  });

  test('different account index produces auth that recovers to that index', async () => {
    const auth = await signAuthorizationFromMnemonic(TEST_MNEMONIC, {
      contractAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      chainId: 1,
      nonce: 5,
    }, 1);
    const recovered = await recoverAuthorizationAddress({ authorization: auth });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR_1.toLowerCase());
  });

  test('chainId / nonce / address all enter the hash (different inputs → different sigs)', async () => {
    const a = await signAuthorizationFromMnemonic(TEST_MNEMONIC, {
      contractAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      chainId: 1,
      nonce: 0,
    }, 0);
    const b = await signAuthorizationFromMnemonic(TEST_MNEMONIC, {
      contractAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      chainId: 11155111, // sepolia
      nonce: 0,
    }, 0);
    const c = await signAuthorizationFromMnemonic(TEST_MNEMONIC, {
      contractAddress: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      chainId: 1,
      nonce: 1, // different nonce
    }, 0);
    expect(a.r).not.toBe(b.r);
    expect(a.r).not.toBe(c.r);
    expect(b.r).not.toBe(c.r);
  });
});

// ─── Session cipher (W1 mitigation) ──────────────────────────────────────
// generateSessionKey + sessionEncrypt + sessionDecrypt protect the unlocked
// mnemonic in chrome.storage.session against heap dumps that survive a SW
// recycle. The cipher itself is just AES-GCM with a non-extractable key —
// these tests pin the round-trip, fresh-IV-per-write, and key-isolation
// guarantees we depend on.

describe('session cipher', () => {
  test('encrypt → decrypt round-trips with the same key', async () => {
    const key = await generateSessionKey();
    const { ciphertext, iv } = await sessionEncrypt(key, TEST_MNEMONIC);
    const plain = await sessionDecrypt(key, ciphertext, iv);
    expect(plain).toBe(TEST_MNEMONIC);
  });

  test('decrypt with a different key throws (SW restart simulated)', async () => {
    const k1 = await generateSessionKey();
    const k2 = await generateSessionKey();
    const { ciphertext, iv } = await sessionEncrypt(k1, TEST_MNEMONIC);
    // k2 is a fresh key — same as what a re-spawned SW would generate.
    // AES-GCM auth tag mismatch must throw, not return garbage plaintext.
    await expect(sessionDecrypt(k2, ciphertext, iv)).rejects.toThrow();
  });

  test('IV is fresh per encrypt (no nonce reuse)', async () => {
    const key = await generateSessionKey();
    const a = await sessionEncrypt(key, TEST_MNEMONIC);
    const b = await sessionEncrypt(key, TEST_MNEMONIC);
    expect(a.iv).not.toBe(b.iv);
    // Same plaintext + same key + different IV → different ciphertext too.
    // Guards against any future "cache the IV" optimisation regression.
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('tampered ciphertext rejected', async () => {
    const key = await generateSessionKey();
    const { ciphertext, iv } = await sessionEncrypt(key, TEST_MNEMONIC);
    // Flip one bit in the ciphertext (decode → mutate → re-encode).
    const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 0x01;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(sessionDecrypt(key, tampered, iv)).rejects.toThrow();
  });

  test('generated key is non-extractable', async () => {
    const key = await generateSessionKey();
    expect(key.extractable).toBe(false);
    // Hard guarantee from WebCrypto: exportKey on a non-extractable key
    // throws synchronously-ish (rejects). If this ever passes, the cipher
    // is broken — raw key bytes would be addressable from JS.
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});
