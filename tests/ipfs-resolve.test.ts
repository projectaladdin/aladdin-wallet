// Pin behavior of resolveTokenUri: the user-reported failure was a
// 504 Gateway Timeout on `https://ipfs.io/ipfs/...` URLs cached in
// older NftRecord.image fields. resolveTokenUri now rewrites known
// gateway URLs to the preferred mirror at render time so stale
// records auto-recover without re-add.

import { describe, it, expect } from 'bun:test';
import { resolveTokenUri, collectImageCandidates } from '../src/core/erc721';

const PREFERRED_PREFIX = 'https://nftstorage.link/ipfs/';
const CID = 'bafkreiapk3pn7unvl4ecpwxn4wzm2assd5ogmoxccviag2vlastnq56uxa';

describe('resolveTokenUri', () => {
  it('expands ipfs:// to the preferred gateway', () => {
    expect(resolveTokenUri(`ipfs://${CID}`)).toBe(`${PREFERRED_PREFIX}${CID}`);
  });
  it('strips the `ipfs/` prefix some indexers prepend (`ipfs://ipfs/CID`)', () => {
    expect(resolveTokenUri(`ipfs://ipfs/${CID}`)).toBe(`${PREFERRED_PREFIX}${CID}`);
  });
  it('rewrites stale ipfs.io URLs onto the preferred gateway', () => {
    expect(resolveTokenUri(`https://ipfs.io/ipfs/${CID}`)).toBe(`${PREFERRED_PREFIX}${CID}`);
  });
  it('rewrites cloudflare-ipfs.com (deprecated 2024) onto the preferred gateway', () => {
    expect(resolveTokenUri(`https://cloudflare-ipfs.com/ipfs/${CID}`)).toBe(`${PREFERRED_PREFIX}${CID}`);
  });
  it('rewrites gateway.lighthouse.storage onto the preferred gateway', () => {
    expect(resolveTokenUri(`https://gateway.lighthouse.storage/ipfs/${CID}`)).toBe(`${PREFERRED_PREFIX}${CID}`);
  });
  it('preserves a project-custom IPFS gateway (host not in known list)', () => {
    // A NFT collection running its own CNAME / private pinning gateway
    // (e.g. `gateway.someproject.art/ipfs/CID`) must NOT be rewritten —
    // it may be the only host actually pinning the content. Preserving
    // it lets NftImage include the original URL in the render-time race.
    expect(resolveTokenUri(`https://gateway.someproject.art/ipfs/${CID}`))
      .toBe(`https://gateway.someproject.art/ipfs/${CID}`);
  });
  it('preserves a sub-path after the CID', () => {
    expect(resolveTokenUri(`https://ipfs.io/ipfs/${CID}/0.png`))
      .toBe(`${PREFERRED_PREFIX}${CID}/0.png`);
  });
  it('passes through data: URLs unchanged', () => {
    const data = 'data:application/json;base64,eyJuYW1lIjoidGVzdCJ9';
    expect(resolveTokenUri(data)).toBe(data);
  });
  it('passes through Arweave URLs via ar://', () => {
    expect(resolveTokenUri('ar://abc123')).toBe('https://arweave.net/abc123');
  });
  it('passes through unrelated https URLs unchanged', () => {
    expect(resolveTokenUri('https://example.com/api/nft/1.json'))
      .toBe('https://example.com/api/nft/1.json');
  });
  it('does NOT rewrite a non-gateway URL that happens to contain `/ipfs/`', () => {
    // A random site that uses `/ipfs/` in its path but isn't an IPFS
    // gateway must NOT be rewritten — that would replace the wrong
    // domain entirely.
    expect(resolveTokenUri('https://example.com/ipfs/foo'))
      .toBe('https://example.com/ipfs/foo');
  });
});

describe('collectImageCandidates', () => {
  it('returns empty when no image fields are present', () => {
    expect(collectImageCandidates({})).toEqual([]);
  });
  it('picks the single `image` field when only it is set', () => {
    expect(collectImageCandidates({ image: `ipfs://${CID}` }))
      .toEqual([`${PREFERRED_PREFIX}${CID}`]);
  });
  it('collects all four image-shaped fields in priority order', () => {
    expect(collectImageCandidates({
      image: `ipfs://${CID}`,
      image_url: 'https://cdn.example.com/0.png',
      animation_url: 'https://cdn.example.com/0.mp4',
      image_alt: `ipfs://Qm${'a'.repeat(44)}`,
    })).toEqual([
      `${PREFERRED_PREFIX}${CID}`,
      'https://cdn.example.com/0.png',
      'https://cdn.example.com/0.mp4',
      `https://nftstorage.link/ipfs/Qm${'a'.repeat(44)}`,
    ]);
  });
  it('dedups when two fields resolve to the same URL', () => {
    expect(collectImageCandidates({
      image: `ipfs://${CID}`,
      image_url: `https://ipfs.io/ipfs/${CID}`,
    })).toEqual([`${PREFERRED_PREFIX}${CID}`]);
  });
  it('preserves a project-custom HTTPS gateway alongside the canonical', () => {
    expect(collectImageCandidates({
      image: `https://gateway.someproject.art/ipfs/${CID}`,
      image_alt: `ipfs://${CID}`,
    })).toEqual([
      `https://gateway.someproject.art/ipfs/${CID}`,
      `${PREFERRED_PREFIX}${CID}`,
    ]);
  });
  it('skips non-string, empty, and whitespace-only values', () => {
    expect(collectImageCandidates({
      image: '',
      image_url: '   ',
      animation_url: 42 as unknown as string,
      image_alt: `ipfs://${CID}`,
    })).toEqual([`${PREFERRED_PREFIX}${CID}`]);
  });
});
