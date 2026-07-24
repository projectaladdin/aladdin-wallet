// Mnemonic + AES-GCM key encryption + viem signing wrappers.
//
// Threat model:
// - Encrypted mnemonic lives in chrome.storage.local. If a malicious script
//   gets storage access (extension compromise) the ciphertext alone is useless
//   without the user's password.
// - PBKDF2-SHA256 with 600k iterations (OWASP 2023 recommendation) → password
//   guessing requires ~600k SHA-256 ops per try. Slow enough that a 10-char
//   random password is ~hopeless to brute force.
// - AES-GCM auth tag protects against ciphertext tampering.
//
// What this does NOT defend against:
// - User's machine being malware-compromised at process level (memory scrape
//   while wallet is unlocked). No browser extension can; that's a wallet
//   ergonomic constraint.

import { mnemonicToAccount, generateMnemonic, english, signAuthorization } from 'viem/accounts';
import { hashAuthorization, toHex } from 'viem/utils';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Address, Hex } from 'viem';

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const AES_GCM_KEY_LEN = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export type EncryptedVault = {
  /** Base64 of [salt | iv | ciphertext+tag]. */
  blob: string;
  /** PBKDF2 param so future migrations can read old vaults. */
  iterations: number;
  /** Vault format version — bump when changing layout. */
  version: 1;
};

/** Generate a fresh BIP-39 12-word mnemonic. */
export function newMnemonic(): string {
  return generateMnemonic(english, 128);
}

/** Derive an Ethereum address from a mnemonic without exposing the key.
 *  `index` is the BIP-44 addressIndex (m/44'/60'/0'/0/index). Defaults to 0
 *  for back-compat with single-account callsites. */
export function addressFromMnemonic(mnemonic: string, index = 0): Address {
  return mnemonicToAccount(mnemonic, { addressIndex: index }).address;
}

/** BIP-39 checksum validation. Wrong wordlist / typo'd word → false. */
export function isValidMnemonic(s: string): boolean {
  return validateMnemonic(s.trim().toLowerCase(), wordlist);
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: PBKDF2_HASH },
    passKey,
    { name: 'AES-GCM', length: AES_GCM_KEY_LEN },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(mnemonic) as BufferSource,
    ),
  );
  // Layout: salt || iv || cipher
  const blob = new Uint8Array(salt.length + iv.length + cipher.length);
  blob.set(salt, 0);
  blob.set(iv, salt.length);
  blob.set(cipher, salt.length + iv.length);
  return {
    blob: btoa(String.fromCharCode(...blob)),
    iterations: PBKDF2_ITERATIONS,
    version: 1,
  };
}

// ─── SW-ephemeral session cipher (W1 mitigation) ──────────────────────────
// The SW caches the unlocked mnemonic in chrome.storage.session so a SW
// recycle doesn't surprise-relock the user mid-30-min-window. Without
// extra protection the phrase sits there as a plain JS string in
// browser-process memory.
//
// Wrap it in an AES-GCM layer keyed by a non-extractable key generated
// fresh on each SW boot and held only in this module's closure. When
// the SW dies, the key dies with it; the ciphertext in session storage
// becomes unrecoverable, and the user is forced to re-unlock. Cost:
// the browser-restart UX requires re-entering the password rather
// than silently restoring the unlocked session. The runtime
// `unlockedMnemonic` JS-string still exists transiently while signing,
// since viem's account derivation needs a string — that's the
// irreducible exposure for any signing wallet.
//
// `extractable: false` means raw key bytes are not addressable from JS;
// a heap dump finds the opaque CryptoKey handle, but the key material
// lives in V8's WebCrypto-internal buffer (separate from the JS heap
// in current Chrome implementations). Defence-in-depth, not a hard
// guarantee — process-level memory dumps still see whatever the
// browser process allocates.

export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_GCM_KEY_LEN },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

export async function sessionEncrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  const cipher = new Uint8Array(cipherBuf);
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...cipher)),
  };
}

export async function sessionDecrypt(
  key: CryptoKey,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const cipherBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    cipherBytes as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

export async function decryptMnemonic(vault: EncryptedVault, password: string): Promise<string> {
  if (vault.version !== 1) throw new Error(`unknown vault version: ${vault.version}`);
  const blob = Uint8Array.from(atob(vault.blob), (c) => c.charCodeAt(0));
  const salt = blob.slice(0, SALT_BYTES);
  const iv = blob.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const cipher = blob.slice(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(password, salt, vault.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // AES-GCM auth tag mismatch ⇒ wrong password (or corrupted vault).
    throw new Error('wrong password');
  }
}

/** Wire-safe shape of a signed 7702 authorization — every field is a string
 *  or number, no BigInt. Chrome's runtime.sendMessage / sendResponse path
 *  serialises responses for cross-context delivery; while structuredClone
 *  technically supports BigInt (Chrome 75+), in practice sendResponse with a
 *  BigInt-containing value can silently drop the response on some Chrome
 *  builds — the awaiter on the content-script side never resolves, dapp
 *  hangs. We strip viem's legacy `v: bigint` field; viem's
 *  `sendTransaction({authorizationList})` reads `yParity` first, so the
 *  serialised type-4 tx is identical. */
export type WireAuthorization = {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
};

/**
 * Sign an EIP-7702 authorization. viem's signAuthorization works for
 * mnemonic-derived (HD) accounts since they're local accounts with raw
 * private key access. The same call from a browser-injected wallet would
 * fail because viem's action does not support JSON-RPC accounts — that
 * limitation is exactly why this extension exists.
 */
export async function signAuthorizationFromMnemonic(
  mnemonic: string,
  params: { contractAddress: Address; chainId: number; nonce: number },
  index = 0,
): Promise<WireAuthorization> {
  const account = mnemonicToAccount(mnemonic, { addressIndex: index });
  const pk = account.getHdKey().privateKey;
  if (!pk) throw new Error('mnemonic did not produce a private key');
  const signed = await signAuthorization({
    privateKey: toHex(pk),
    address: params.contractAddress,
    chainId: params.chainId,
    nonce: params.nonce,
  });
  // Strip `v: bigint` so the response survives chrome.runtime sendResponse's
  // serialisation. yParity (0 | 1) is sufficient — viem's tx serialiser
  // prefers it, and any consumer that needs `v` can derive it as 27+yParity.
  // Derive yParity from `v` if viem returned the legacy shape (TS union has
  // it optional; in practice EIP-7702 signatures always carry yParity).
  const yParity =
    signed.yParity !== undefined
      ? signed.yParity
      : signed.v !== undefined
        ? Number(signed.v >= 27n ? signed.v - 27n : signed.v)
        : 0;
  return {
    address: signed.address,
    chainId: signed.chainId,
    nonce: signed.nonce,
    r: signed.r,
    s: signed.s,
    yParity,
  };
}

/** Sign personal_sign (EIP-191) — accepts utf8 string or 0x-prefixed bytes. */
export async function signMessageFromMnemonic(
  mnemonic: string,
  message: string | { raw: Hex },
  index = 0,
): Promise<Hex> {
  const account = mnemonicToAccount(mnemonic, { addressIndex: index });
  return account.signMessage({ message });
}

/** Parse the dapp-supplied typed-data payload, which can be a JSON string OR
 *  an already-decoded object (libs differ — MetaMask docs example uses string,
 *  ethers/viem often pass object). */
export function parseTypedData(raw: unknown): {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== 'object') throw new Error('invalid typed data');
  const o = obj as {
    domain?: Record<string, unknown>;
    types?: Record<string, { name: string; type: string }[]>;
    primaryType?: string;
    message?: Record<string, unknown>;
  };
  if (!o.types || !o.primaryType || !o.message || !o.domain) {
    throw new Error('typed data missing domain/types/primaryType/message');
  }
  return {
    domain: o.domain,
    types: o.types,
    primaryType: o.primaryType,
    message: o.message,
  };
}

/** Sign EIP-712 typed data. viem strips the EIP712Domain entry from `types`
 *  internally if present. */
export async function signTypedDataFromMnemonic(
  mnemonic: string,
  raw: unknown,
  index = 0,
): Promise<Hex> {
  const { domain, types, primaryType, message } = parseTypedData(raw);
  const account = mnemonicToAccount(mnemonic, { addressIndex: index });
  const cleanTypes = { ...types };
  delete (cleanTypes as { EIP712Domain?: unknown }).EIP712Domain;
  return account.signTypedData({
    domain: domain as Parameters<typeof account.signTypedData>[0]['domain'],
    types: cleanTypes,
    primaryType,
    message,
  } as Parameters<typeof account.signTypedData>[0]);
}

// Re-export viem helper for tests / debugging.
export { hashAuthorization };
