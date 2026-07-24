// NFT (ERC-721 / ERC-1155) read helpers. Mirrors core/erc20.ts patterns:
// minimal ABI surface, viem-based public client, defensive fallbacks for
// flaky metadata sources.
//
// Scope: read-only metadata + ownership verification. Not a full NFT
// indexer — NFT support is "user pastes contract + tokenId, wallet
// reads on-chain + IPFS metadata". Auto-discovery via Alchemy /
// Reservoir / similar is intentionally out of scope: those APIs need
// a per-app key, leak the user's address per request, and bind the
// wallet to a specific third-party indexer.

import { createPublicClient, http, type Address, type Chain } from 'viem';

/** EIP-165 supportsInterface — the standard probe for "is this an
 *  ERC-721 / ERC-1155?". Both standards mandate ERC-165 support. */
export const ERC165_ABI = [
  {
    type: 'function', name: 'supportsInterface', stateMutability: 'view',
    inputs: [{ type: 'bytes4', name: 'interfaceId' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const ERC721_ABI = [
  { type: 'function', name: 'name',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function', name: 'tokenURI', stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'tokenId' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'tokenId' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export const ERC1155_ABI = [
  {
    type: 'function', name: 'uri', stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'id' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }, { type: 'uint256', name: 'id' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** ERC-165 interface IDs as defined by the token standards themselves.
 *  Reference:
 *    ERC-721:   bytes4(keccak256("balanceOf(address)") ^ ...)  = 0x80ac58cd
 *    ERC-1155:  bytes4(keccak256("balanceOf(address,uint256)") ^ ...) = 0xd9b67a26
 *  These are constants in the standards, not per-deployment. */
export const INTERFACE_ID_ERC721  = '0x80ac58cd' as const;
export const INTERFACE_ID_ERC1155 = '0xd9b67a26' as const;

export type NftStandard = 'ERC721' | 'ERC1155';

export type NftMeta = {
  /** What we determined the contract to be — affects how we fetch metadata
   *  (tokenURI vs uri) and verify ownership (ownerOf vs balanceOf). */
  standard: NftStandard;
  /** Display name from metadata.name — falls back to "<symbol> #<tokenId>"
   *  if the metadata JSON is unreachable. */
  name: string;
  /** Resolved image URLs collected from every image-shaped field on the
   *  metadata JSON, in priority order: `image`, `image_url`, `animation_url`,
   *  `image_alt`. Each entry is already passed through `resolveTokenUri`.
   *  Empty array if the metadata had no recognised image field or the JSON
   *  itself failed to load. The renderer races all entries in parallel so
   *  whichever URL resolves fastest wins. */
  imageCandidates: string[];
  /** Optional description from metadata.description. */
  description: string | null;
};

function client(chain: Chain, rpcUrl: string) {
  return createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
}

/** Probe a contract for ERC-721 / ERC-1155 via supportsInterface.
 *  Returns null if the contract doesn't implement ERC-165 at all (older
 *  NFT contracts, or non-NFT contracts), or if both probes fail. */
export async function detectNftStandard(
  chain: Chain,
  rpcUrl: string,
  contract: Address,
): Promise<NftStandard | null> {
  const c = client(chain, rpcUrl);
  // Try ERC-721 first since it's more common.
  try {
    const is721 = await c.readContract({
      address: contract, abi: ERC165_ABI, functionName: 'supportsInterface',
      args: [INTERFACE_ID_ERC721],
    });
    if (is721) return 'ERC721';
  } catch { /* fall through to ERC-1155 probe */ }
  try {
    const is1155 = await c.readContract({
      address: contract, abi: ERC165_ABI, functionName: 'supportsInterface',
      args: [INTERFACE_ID_ERC1155],
    });
    if (is1155) return 'ERC1155';
  } catch { /* fall through to null */ }
  return null;
}

/** Public IPFS gateways tried in parallel (Promise.any race) when
 *  fetching metadata JSON. ipfs.io is canonical but heavily rate-
 *  limited / 504s frequently in 2026 — we keep it as a fallback but
 *  put working mirrors first so the typical path doesn't even touch
 *  it. CSP in manifest.json allows `https:` broadly so any gateway
 *  works at the network layer.
 *
 *  Order is preference for the FIRST-tried gateway when we need a
 *  single URL (`resolveTokenUri` for `<img src=…>`, no in-process
 *  race possible). For metadata JSON `raceIpfsFetch` hits them all
 *  in parallel and the fastest responder wins.
 */
export const IPFS_GATEWAYS = [
  'https://nftstorage.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://4everland.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.lighthouse.storage/ipfs/',
] as const;

/** Match the `/ipfs/<CID>[/path]` tail of any public-gateway URL.
 *  Used to rewrite stale ipfs.io URLs (cached in NftRecord.image
 *  from older adds) to a fresher gateway at render time. */
const IPFS_PATH_RE = /\/ipfs\/([^/?#]+(?:\/[^?#]*)?)/;

/** Resolve a token-URI value to an HTTP URL we can `fetch`.
 *
 *  Handles:
 *    - `ipfs://CID/path` → preferred IPFS gateway + CID
 *    - `data:application/json;...` → returned as-is (caller can fetch)
 *    - `https://<known-gateway>/ipfs/CID` → REWRITTEN to preferred
 *      gateway so a slow/dead gateway baked into stored metadata
 *      doesn't trap the user on every render.
 *    - other `https://…` / `http://…` → returned as-is
 *    - `ar://…` (Arweave) → arweave.net resolver
 */
export function resolveTokenUri(uri: string): string {
  const u = uri.trim();
  if (u.startsWith('ipfs://')) {
    return IPFS_GATEWAYS[0] + u.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  if (u.startsWith('ar://')) {
    return 'https://arweave.net/' + u.slice('ar://'.length);
  }
  // Pin-rewrite any public-gateway URL onto the preferred mirror.
  // Matches both `https://ipfs.io/ipfs/X` and `https://gateway.pinata.cloud/ipfs/X`
  // by the `/ipfs/<path>` substring, which is the canonical shape.
  if (/^https?:\/\//.test(u)) {
    try {
      const host = new URL(u).host;
      const isKnownGateway = host === 'ipfs.io'
        || host === 'cloudflare-ipfs.com'  // deprecated 2024, redirect-only
        || host === 'dweb.link'
        || host === 'gateway.pinata.cloud'
        || host === 'w3s.link'
        || host === 'nftstorage.link'
        || host === '4everland.io'
        || host === 'gateway.lighthouse.storage';
      const m = u.match(IPFS_PATH_RE);
      if (isKnownGateway && m) return IPFS_GATEWAYS[0] + m[1];
    } catch { /* malformed URL, fall through */ }
  }
  return u;
}

/** Race the same IPFS path across every gateway in parallel; first to
 *  respond with 2xx wins. Used by metadata fetch where we control the
 *  fetch. Returns the response's text body so the caller can JSON.parse
 *  without a separate stream pass. Times out at `timeoutMs` total (not
 *  per-gateway) — that's the upper bound on "we waited too long for
 *  even ONE gateway to come back". */
async function raceIpfsFetch(cidPath: string, timeoutMs = 8_000): Promise<string> {
  const controllers = IPFS_GATEWAYS.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach((c) => c.abort()), timeoutMs);
  try {
    const fetches = IPFS_GATEWAYS.map(async (gw, i) => {
      const res = await fetch(gw + cidPath, {
        signal: controllers[i]!.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`gateway ${gw} → ${res.status}`);
      return res.text();
    });
    const winner = await Promise.any(fetches);
    // Cancel the losers so we don't keep slow connections open.
    controllers.forEach((c) => c.abort());
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

/** If the URL is a public-gateway IPFS path, extract the `/ipfs/<...>`
 *  tail so callers can race it across mirrors. Returns null when the
 *  URL has no IPFS shape (data: URLs, arbitrary https, arweave, etc.) */
export function ipfsTailFromUrl(u: string): string | null {
  if (u.startsWith('ipfs://')) {
    return u.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  if (!/^https?:\/\//.test(u)) return null;
  const m = u.match(IPFS_PATH_RE);
  return m ? m[1]! : null;
}


/** ERC-1155's `uri()` standard mandates a `{id}` placeholder substitution
 *  with the 0-padded 64-char hex token ID. Implementations split on this:
 *  some return the literal `{id}` string and expect the caller to
 *  substitute; some pre-substitute server-side. Handle both. */
function substituteErc1155Id(uri: string, tokenId: bigint): string {
  if (!uri.includes('{id}')) return uri;
  const hex = tokenId.toString(16).padStart(64, '0');
  return uri.replace(/\{id\}/g, hex);
}

/** Fetch + parse a metadata JSON document. data: URLs are decoded
 *  in-process; IPFS URLs (whether `ipfs://` form or already resolved
 *  to a public gateway) race across `IPFS_GATEWAYS` so a single slow
 *  gateway can't stall the whole add-NFT flow. Other https URLs
 *  fetch once with a 10 s ceiling. */
async function fetchMetadataJson(url: string): Promise<{
  name?: string;
  description?: string;
  image?: string;
  image_url?: string;
  animation_url?: string;
  image_alt?: string;
} | null> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    const header = url.slice(0, comma);
    const body = url.slice(comma + 1);
    try {
      const text = header.includes(';base64')
        ? atob(body)
        : decodeURIComponent(body);
      return JSON.parse(text);
    } catch { return null; }
  }
  // IPFS path → race across every gateway.
  const ipfsTail = ipfsTailFromUrl(url);
  if (ipfsTail !== null) {
    try {
      const text = await raceIpfsFetch(ipfsTail);
      return JSON.parse(text);
    } catch { return null; }
  }
  // Plain https — single fetch with a per-request abort timer so a
  // dead host doesn't hang the SW indefinitely.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

/** Read a single NFT's metadata. Returns a best-effort `NftMeta` —
 *  every field except `standard` may degrade if metadata fetches
 *  fail. The wallet always shows what it has rather than blocking
 *  the user behind perfect metadata. */
export async function fetchNftMeta(
  chain: Chain,
  rpcUrl: string,
  contract: Address,
  tokenId: bigint,
  standard: NftStandard,
): Promise<NftMeta> {
  const c = client(chain, rpcUrl);
  // Default name: "<symbol or address> #<id>" — used only if metadata JSON
  // doesn't deliver a `name` field.
  let collectionLabel: string;
  try {
    if (standard === 'ERC721') {
      const sym = await c.readContract({
        address: contract, abi: ERC721_ABI, functionName: 'symbol',
      }) as string;
      collectionLabel = sym;
    } else {
      collectionLabel = `${contract.slice(0, 6)}…${contract.slice(-4)}`;
    }
  } catch {
    collectionLabel = `${contract.slice(0, 6)}…${contract.slice(-4)}`;
  }
  const fallbackName = `${collectionLabel} #${tokenId.toString()}`;

  // Resolve tokenURI / uri.
  let rawUri: string;
  try {
    if (standard === 'ERC721') {
      rawUri = await c.readContract({
        address: contract, abi: ERC721_ABI, functionName: 'tokenURI',
        args: [tokenId],
      }) as string;
    } else {
      const u = await c.readContract({
        address: contract, abi: ERC1155_ABI, functionName: 'uri',
        args: [tokenId],
      }) as string;
      rawUri = substituteErc1155Id(u, tokenId);
    }
  } catch {
    return { standard, name: fallbackName, imageCandidates: [], description: null };
  }

  const metaJson = await fetchMetadataJson(resolveTokenUri(rawUri));
  if (!metaJson) {
    return { standard, name: fallbackName, imageCandidates: [], description: null };
  }
  return {
    standard,
    name: typeof metaJson.name === 'string' ? metaJson.name : fallbackName,
    imageCandidates: collectImageCandidates(metaJson),
    description: typeof metaJson.description === 'string' ? metaJson.description : null,
  };
}

/** Pull every image-shaped field off a metadata JSON object, resolve each
 *  through `resolveTokenUri`, and dedup. Priority order (highest first):
 *
 *    - `image`         — EIP-721 / EIP-1155 standard field, always tried first.
 *    - `image_url`     — OpenSea metadata convention, frequently an HTTPS
 *                        CDN mirror of the canonical `image` IPFS URI.
 *    - `animation_url` — OpenSea convention for video/GIF/HTML; some
 *                        collections use it as an image fallback for
 *                        static thumbnails.
 *    - `image_alt`     — non-standard, but seen in the wild as the
 *                        minter's explicit "if the main image dies, use
 *                        this" hint.
 *
 *  The renderer races all candidates in parallel, so this list is just
 *  the "what to consider"; the actual winner is whichever URL the user's
 *  network resolves fastest. We never pick by spec priority alone. */
export function collectImageCandidates(meta: {
  image?: unknown;
  image_url?: unknown;
  animation_url?: unknown;
  image_alt?: unknown;
}): string[] {
  const fields = ['image', 'image_url', 'animation_url', 'image_alt'] as const;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of fields) {
    const v = meta[k];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const resolved = resolveTokenUri(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** Verify the user owns this NFT before adding it to their list. Skipping
 *  this would let dapps spam-add NFTs they only LINKED to (phishing
 *  airdrop pattern). For ERC-1155 we treat balance>0 as "owned"; for
 *  ERC-721 we strict-compare ownerOf == owner.
 *
 *  Returns null on RPC failure — the caller should still allow adding,
 *  since some legitimate cases (chain ID mismatch on a custom RPC, etc.)
 *  legitimately can't verify. UI should warn but not block. */
/** Result of an NFT ownership check. The caller wants to distinguish
 *  three negative outcomes so the UI can tell the user what to do:
 *    - `not-minted`: tokenId has never been issued. User should mint
 *      first (or pick a real id) — adding is pointless.
 *    - `wrong-owner`: tokenId exists but a different address holds it.
 *      Classic phishing pattern; refuse the add.
 *    - `rpc-unknown`: RPC failure / network blip — we let the add
 *      through anyway because legitimate cases (custom chain, flaky
 *      RPC) shouldn't block the user.
 *  And the positive case `owns` (proceed). */
export type OwnershipResult =
  | { kind: 'owns' }
  | { kind: 'not-minted' }
  | { kind: 'wrong-owner'; actual?: Address }
  | { kind: 'rpc-unknown' };

export async function verifyNftOwnership(
  chain: Chain,
  rpcUrl: string,
  contract: Address,
  tokenId: bigint,
  standard: NftStandard,
  owner: Address,
): Promise<OwnershipResult> {
  const c = client(chain, rpcUrl);
  try {
    if (standard === 'ERC721') {
      const actual = await c.readContract({
        address: contract, abi: ERC721_ABI, functionName: 'ownerOf',
        args: [tokenId],
      }) as Address;
      if (actual.toLowerCase() === owner.toLowerCase()) return { kind: 'owns' };
      return { kind: 'wrong-owner', actual };
    }
    const bal = await c.readContract({
      address: contract, abi: ERC1155_ABI, functionName: 'balanceOf',
      args: [owner, tokenId],
    }) as bigint;
    return bal > 0n ? { kind: 'owns' } : { kind: 'wrong-owner' };
  } catch (e) {
    // ERC-721 `ownerOf(id)` reverts for never-minted ids. Older OZ
    // versions revert with `"ERC721: owner query for nonexistent
    // token"`, OZ 5.x uses the custom error `ERC721NonexistentToken`,
    // our test fixture uses `"not minted"`. Surface separately so the
    // caller can tell the user "mint first" instead of the generic
    // "you don't own this" copy that fits a phishing scenario.
    if (isTokenNonexistentError(e)) return { kind: 'not-minted' };
    return { kind: 'rpc-unknown' };
  }
}

/** Match revert reasons that mean "tokenId doesn't exist on this
 *  contract". Conservative pattern set — substring matches only,
 *  no regex. False negatives (a contract using bespoke wording)
 *  fall through to `null` = "RPC said something we can't classify". */
function isTokenNonexistentError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return (
    msg.includes('nonexistent token')
    || msg.includes('erc721nonexistenttoken')
    || msg.includes('not minted')
    || msg.includes('owner query for nonexistent')
    || msg.includes('uri query for nonexistent')
    || msg.includes('invalid token id')
    || msg.includes('token does not exist')
  );
}

/** Owned-count for an ERC-1155 (id-specific). For ERC-721 the answer is
 *  always 1 by definition (NFT = non-fungible). Returns null on RPC
 *  failure so callers can fall back to "show no count" rather than
 *  blocking the card render. */
export async function getNftBalance(
  chain: Chain,
  rpcUrl: string,
  contract: Address,
  tokenId: bigint,
  standard: NftStandard,
  owner: Address,
): Promise<bigint | null> {
  if (standard === 'ERC721') return 1n;
  try {
    return (await client(chain, rpcUrl).readContract({
      address: contract, abi: ERC1155_ABI, functionName: 'balanceOf',
      args: [owner, tokenId],
    })) as bigint;
  } catch {
    return null;
  }
}
