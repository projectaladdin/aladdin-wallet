// Pure validator functions extracted so they can be unit-tested without
// pulling in chrome / viem / DOM. background.ts re-exports the same names
// so existing call sites stay unchanged.
//
// Every validator returns the FIRST defect as a string, or null when the
// payload is structurally signable. Callers translate non-null returns
// into EIP-1474 -32602 errors and refuse the request before opening any
// popup; null returns hand off to the popup queue.

/** EIP-712 schema sanity check. Covers the six standard malformed cases
 *  + EIP712Domain canonical four-rule check (allowed names, canonical
 *  ascending order, exact spec types, domain ↔ types parity). Recursive
 *  walk of `message` enforces "no extra fields not declared in types"
 *  (decoy attack). */
/** Hard cap on the payload size we'll even try to parse. A hostile
 *  dapp can call `eth_signTypedData_v4` with a multi-MB JSON blob —
 *  chrome.runtime.sendMessage accepts up to ~64 MB. The SW's main
 *  thread is single-threaded; JSON.parse + recursive walk on a
 *  10 MB payload freezes every other dapp + popup interaction for
 *  multiple seconds. 256 KB is generous (real-world Permit / SafeTx
 *  payloads run a few KB at most). */
const MAX_TYPED_DATA_BYTES = 256 * 1024;
/** Hard cap on recursion depth in `checkExtras`. A recursive type
 *  (`struct Foo { f: Foo[]; }`) combined with deeply-nested `message`
 *  arrays would otherwise stack-overflow the validator. 32 is several
 *  times the depth of any real EIP-712 schema seen in the wild. */
const MAX_TYPED_DATA_DEPTH = 32;

export function validateTypedDataSchema(raw: unknown): string | null {
  // Cheap pre-check before the JSON.parse — if the raw payload is
  // string-shaped (the wire form from EIP-1193) we can reject by
  // .length without parsing. Object form falls through to the size
  // cap further down in walk-time.
  if (typeof raw === 'string' && raw.length > MAX_TYPED_DATA_BYTES) {
    return `typed data too large: ${raw.length} bytes > ${MAX_TYPED_DATA_BYTES} cap`;
  }
  let obj: unknown;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return 'params is not valid JSON'; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return 'typed data must be an object';
  }
  const o = obj as {
    primaryType?: unknown; types?: unknown;
    domain?: unknown; message?: unknown;
  };

  if (typeof o.primaryType !== 'string' || !o.primaryType) {
    return 'primaryType is missing or not a string';
  }
  if (!o.types || typeof o.types !== 'object' || Array.isArray(o.types)) {
    return 'types is missing or not an object';
  }
  const types = o.types as Record<string, { name: string; type: string }[]>;

  if (!(o.primaryType in types)) {
    return `primaryType "${o.primaryType}" is not declared in types`;
  }

  if (!('EIP712Domain' in types)) {
    return 'types.EIP712Domain is missing — required to hash the domain separator';
  }
  if (!Array.isArray(types.EIP712Domain) || types.EIP712Domain.length === 0) {
    return 'types.EIP712Domain must be a non-empty array of {name, type}';
  }
  const CANONICAL_DOMAIN_ORDER = ['name', 'version', 'chainId', 'verifyingContract', 'salt'] as const;
  const CANONICAL_DOMAIN_TYPES: Record<string, string> = {
    name: 'string',
    version: 'string',
    chainId: 'uint256',
    verifyingContract: 'address',
    salt: 'bytes32',
  };
  const declaredDomain = types.EIP712Domain;
  const declaredNames = declaredDomain.map((f) => f.name);
  for (const name of declaredNames) {
    if (!(CANONICAL_DOMAIN_ORDER as readonly string[]).includes(name)) {
      return `types.EIP712Domain has unknown field "${name}" — only name/version/chainId/verifyingContract/salt are valid per EIP-712`;
    }
  }
  let lastIdx = -1;
  for (const name of declaredNames) {
    const idx = CANONICAL_DOMAIN_ORDER.indexOf(name as typeof CANONICAL_DOMAIN_ORDER[number]);
    if (idx <= lastIdx) {
      return `types.EIP712Domain fields out of canonical order — got [${declaredNames.join(', ')}], spec requires the order ${CANONICAL_DOMAIN_ORDER.join(' < ')}`;
    }
    lastIdx = idx;
  }
  for (const f of declaredDomain) {
    const expected = CANONICAL_DOMAIN_TYPES[f.name];
    if (f.type !== expected) {
      return `types.EIP712Domain.${f.name} must be ${expected}, got ${f.type}`;
    }
  }

  // Atomic types: address / bool / string / bytes[1..32] / bytes /
  // uint{8,16,...,256} / int{8,16,...,256}. Bare `uint` / `int` / `byte`
  // not allowed; non-multiple-of-8 widths not allowed.
  const ATOMIC_RE = /^(?:address|bool|string|bytes(?:[1-9]|[12][0-9]|3[0-2])?|uint(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)|int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/;
  const baseType = (t: string): string => t.replace(/(?:\[\d*\])+$/, '');
  const arraySuffix = (t: string): string => t.slice(baseType(t).length);
  const isValidArraySuffix = (s: string): boolean => /^(?:\[\d*\])*$/.test(s);
  const isValidType = (t: string): boolean => {
    if (typeof t !== 'string' || t === '') return false;
    if (!isValidArraySuffix(arraySuffix(t))) return false;
    const base = baseType(t);
    return ATOMIC_RE.test(base) || base in types;
  };

  for (const [structName, fields] of Object.entries(types)) {
    if (!Array.isArray(fields)) {
      return `types["${structName}"] must be an array of {name, type}`;
    }
    for (const f of fields) {
      if (!f || typeof f !== 'object') {
        return `types["${structName}"] has a non-object field`;
      }
      const fn = (f as { name?: unknown }).name;
      const ft = (f as { type?: unknown }).type;
      if (typeof fn !== 'string' || !fn) {
        return `types["${structName}"] has a field with no name`;
      }
      if (typeof ft !== 'string' || !isValidType(ft)) {
        return `types["${structName}"].${fn} has invalid type "${String(ft)}"`;
      }
    }
  }

  if (o.domain !== undefined) {
    if (o.domain === null || typeof o.domain !== 'object' || Array.isArray(o.domain)) {
      return 'domain is missing or not an object';
    }
    const d = o.domain as {
      name?: unknown; version?: unknown;
      chainId?: unknown; verifyingContract?: unknown; salt?: unknown;
    };
    const hasReplayBinding =
      d.chainId !== undefined ||
      d.verifyingContract !== undefined ||
      d.salt !== undefined;
    if (!hasReplayBinding) {
      return 'domain has no chainId, verifyingContract, or salt — signature would replay across any dapp';
    }
    const vc = d.verifyingContract;
    if (vc !== undefined && vc !== null) {
      if (typeof vc !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(vc)) {
        return 'domain.verifyingContract is not a valid 20-byte address';
      }
    }
    // EIP-712: `salt` MUST be a bytes32 value when present. Pre-fix
    // the validator only checked the TYPE was declared as bytes32
    // in `types.EIP712Domain`, never the actual `domain.salt` length
    // — a payload with `salt: "0x00"` (1 byte) would hash differently
    // than a strict counterparty expects, and the wallet would still
    // sign it. Enforcing 32 bytes here keeps signatures portable.
    const salt = d.salt;
    if (salt !== undefined && salt !== null) {
      if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
        return 'domain.salt must be exactly 32 bytes (66-char 0x-hex)';
      }
    }
    const declaredSet = new Set(declaredNames);
    const objKeys = Object.keys(d as Record<string, unknown>);
    const objSet = new Set(objKeys);
    for (const k of objKeys) {
      if (!declaredSet.has(k)) {
        return `domain has key "${k}" not declared in types.EIP712Domain — would NOT be hashed (decoy field)`;
      }
    }
    for (const name of declaredNames) {
      if (!objSet.has(name)) {
        return `domain is missing "${name}" which is declared in types.EIP712Domain — would hash as zero/empty`;
      }
    }
  } else {
    return 'domain is missing — signature would replay across any dapp';
  }

  const message = o.message;
  if (message !== undefined && message !== null) {
    if (typeof message !== 'object') {
      return 'message must be an object';
    }
    const checkExtras = (node: unknown, typeName: string, path: string, depth: number): string | null => {
      // Depth guard — recursive types + deeply nested arrays would
      // otherwise blow the stack on a malicious payload.
      if (depth > MAX_TYPED_DATA_DEPTH) {
        return `typed data nests too deep (>${MAX_TYPED_DATA_DEPTH}) — refusing to walk`;
      }
      const base = baseType(typeName);
      const fields = types[base];
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const err = checkExtras(node[i], base, `${path}[${i}]`, depth + 1);
          if (err) return err;
        }
        return null;
      }
      if (!node || typeof node !== 'object') return null;
      if (!fields) return null;
      const declared = new Set(fields.map((f) => f.name));
      for (const k of Object.keys(node as Record<string, unknown>)) {
        if (!declared.has(k)) {
          const fullPath = path ? `${path}.${k}` : k;
          return `message field "${fullPath}" is not declared in types["${base}"] — would NOT be signed (decoy field)`;
        }
        const f = fields.find((x) => x.name === k)!;
        const childBase = baseType(f.type);
        if (childBase in types) {
          const err = checkExtras(
            (node as Record<string, unknown>)[k],
            f.type,
            path ? `${path}.${k}` : k,
            depth + 1,
          );
          if (err) return err;
        }
      }
      return null;
    };
    const extrasErr = checkExtras(message, o.primaryType as string, '', 0);
    if (extrasErr) return extrasErr;
  }

  return null;
}

/** Sanity-check eth_sendTransaction params. Returns first defect or null.
 *  Per EIP-1474, all numeric fields are hex-prefixed strings (`0x...`) and
 *  addresses are 20-byte hex. Tx envelope type restricted to known EIP-2718
 *  values (0=legacy, 1=EIP-2930, 2=EIP-1559, 3=EIP-4844, 4=EIP-7702). */
export function validateSendTransactionParams(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return 'params must be a non-empty array';
  const tx = raw[0];
  if (!tx || typeof tx !== 'object') return 'params[0] must be a tx object';
  const t = tx as Record<string, unknown>;
  if (t.to !== undefined && t.to !== null) {
    if (typeof t.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.to)) {
      return 'tx.to is not a valid 20-byte address';
    }
  }
  const hexFields = [
    'value', 'gas', 'gasLimit', 'gasPrice', 'nonce',
    'maxFeePerGas', 'maxPriorityFeePerGas',
  ] as const;
  for (const k of hexFields) {
    const v = t[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !/^0x([0-9a-fA-F]+)$/.test(v)) {
      return `tx.${k} must be hex-prefixed (got ${typeof v === 'string' ? `"${v}"` : typeof v})`;
    }
  }
  if (t.data !== undefined && t.data !== null) {
    if (typeof t.data !== 'string' || !/^0x([0-9a-fA-F]*)$/.test(t.data)) {
      return 'tx.data must be hex-prefixed';
    }
  }
  if (t.type !== undefined && t.type !== null) {
    if (typeof t.type !== 'string' || !/^0x[0-4]$/i.test(t.type)) {
      return `tx.type "${String(t.type)}" is not a known EIP-2718 envelope (must be 0x0…0x4)`;
    }
  }
  return null;
}

/** EIP-747 wallet_watchAsset params. Supports `ERC20` (fungible) +
 *  `ERC721` / `ERC1155` (NFTs). Returns first defect or null.
 *  Spec: https://eips.ethereum.org/EIPS/eip-747 */
export function validateWatchAssetParams(raw: unknown): string | null {
  // Some dapps wrap params in [{...}] (per JSON-RPC convention), some
  // pass the bare object — accept both shapes per the spec example.
  const p = (Array.isArray(raw) ? raw[0] : raw) as
    | undefined
    | { type?: unknown; options?: unknown };
  if (!p || typeof p !== 'object') return 'params must be an object (or [object])';

  const type = p.type;
  if (type !== 'ERC20' && type !== 'ERC721' && type !== 'ERC1155') {
    return `unsupported asset type "${String(type)}" — expected ERC20 / ERC721 / ERC1155`;
  }
  if (!p.options || typeof p.options !== 'object') {
    return 'params.options must be an object';
  }
  const o = p.options as {
    address?: unknown;
    symbol?: unknown;
    decimals?: unknown;
    image?: unknown;
    tokenId?: unknown;
  };

  if (typeof o.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.address)) {
    return 'options.address is not a valid 20-byte address';
  }
  if (o.image !== undefined) {
    if (typeof o.image !== 'string') {
      return 'options.image must be a string URL or data URI';
    }
    // Restrict to data:image/* + plain https://. Rejects:
    //   - javascript: / vbscript: (CSP would block, but reject early)
    //   - blob: / filesystem: (could leak popup-local URLs back)
    //   - data:text/html or other non-image data URIs
    //   - bare HTTP (mixed-content; can also be SSRF probes)
    // A `<img>` tag with an attacker-controlled https URL is a
    // tracking pixel the moment the popup renders watchAsset, even
    // before the user approves — restricting the surface mitigates
    // (the attacker has to host on a CDN that's already whitelisted
    // in their CSP, or use a self-contained data URI).
    if (!/^data:image\//i.test(o.image) && !/^https:\/\//i.test(o.image)) {
      return 'options.image must be a data:image/… URI or an https:// URL';
    }
  }

  if (type === 'ERC20') {
    if (o.symbol !== undefined && (typeof o.symbol !== 'string' || o.symbol.length === 0 || o.symbol.length > 11)) {
      return 'options.symbol must be 1–11 chars per EIP-747';
    }
    if (o.decimals !== undefined) {
      if (typeof o.decimals !== 'number' || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 36) {
        return 'options.decimals must be an integer 0–36';
      }
    }
  } else {
    // ERC721 / ERC1155 — tokenId required (per EIP-747 + MetaMask
    // implementation reference). Accept decimal or 0x-prefixed hex.
    if (typeof o.tokenId !== 'string' || o.tokenId.length === 0) {
      return `options.tokenId is required for ${type}`;
    }
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(o.tokenId)) {
      return 'options.tokenId must be a non-negative integer (decimal or 0x-hex)';
    }
  }
  return null;
}

/** Resolve eth_signTypedData params (v1 vs v3/v4) into a uniform shape.
 *  v3/v4: params = [signerAddress, jsonString | object]
 *  v1:    params = [typedDataArray, signerAddress]   (legacy MetaMask form)
 *  Detection: whichever slot looks like an address is the signer. */
export function unpackTypedDataParams(raw: unknown): { signer: string | undefined; data: unknown } {
  const arr = (raw as unknown[]) ?? [];
  const isAddr = (v: unknown): v is string =>
    typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (isAddr(arr[0])) return { signer: arr[0] as string, data: arr[1] };
  if (isAddr(arr[1])) return { signer: arr[1] as string, data: arr[0] };
  return { signer: undefined, data: arr[1] ?? arr[0] };
}
