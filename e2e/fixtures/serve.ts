// Static file server for the e2e fixture dapp + an extra compile
// endpoint that hands back the bundled NFT contracts' bytecode +
// ABI, so the dapp can deploy them via `eth_sendTransaction` for
// manual NFT-flow testing. The dapp page can't run solc-js itself
// (it's a browser, not Node), so the compile happens here and the
// result is JSON'd over HTTP. First compile lazily on demand;
// subsequent fetches hit the in-process cache in erc721-helpers.

import { resolve } from 'node:path';
import { encodeDeployData, type Abi } from 'viem';
import { compileErc1155, compileErc20, compileErc721ForDapp } from './erc721-helpers';

const port = Number(process.argv[2] ?? 4269);
const dappPath = resolve(import.meta.dir, 'test-dapp.html');

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/test-dapp.html' || url.pathname === '/') {
      return new Response(Bun.file(dappPath), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // GET /compile/erc721?tokenURI=... or /compile/erc1155?tokenURI=...
    // → JSON { bytecode, abi }
    //
    // `bytecode` is constructor-args-included (encodeDeployData), so
    // the dapp can just `eth_sendTransaction({data: bytecode})` and
    // get the right deployed state. tokenURI defaults to empty string
    // (wallet's NFT card falls back to 🖼 placeholder) — set it to
    // any data: / ipfs: / https: URL to give the deployed contract
    // real metadata.
    if (url.pathname === '/compile/erc721' || url.pathname === '/compile/erc1155') {
      try {
        const { bytecode, abi } = url.pathname.endsWith('721')
          ? compileErc721ForDapp()
          : compileErc1155();
        const tokenURI = url.searchParams.get('tokenURI') ?? '';
        const deployBytecode = encodeDeployData({
          abi: abi as Abi,
          bytecode,
          args: [tokenURI],
        });
        return new Response(JSON.stringify({ bytecode: deployBytecode, abi }), {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
    }
    // GET /compile/erc20?name=&symbol=&decimals= → JSON { bytecode, abi }
    // Constructor: (string name, string symbol, uint8 decimals).
    // Defaults: name='Test Token' / symbol='TST' / decimals=18 — the
    // typical shape so a one-click Deploy gives a usable token without
    // form fiddling.
    if (url.pathname === '/compile/erc20') {
      try {
        const { bytecode, abi } = compileErc20();
        const name = url.searchParams.get('name') ?? 'Test Token';
        const symbol = url.searchParams.get('symbol') ?? 'TST';
        const decimalsStr = url.searchParams.get('decimals') ?? '18';
        const decimals = Number(decimalsStr);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
          return new Response(
            JSON.stringify({ error: `decimals must be a uint8 (0..255), got "${decimalsStr}"` }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        const deployBytecode = encodeDeployData({
          abi: abi as Abi,
          bytecode,
          args: [name, symbol, decimals],
        });
        return new Response(JSON.stringify({ bytecode: deployBytecode, abi }), {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`fixture dapp serving on http://127.0.0.1:${port}/test-dapp.html`);
console.log(`compile endpoints: /compile/erc721, /compile/erc1155`);
