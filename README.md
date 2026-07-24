# Aladdin Wallet

[![CI](https://github.com/projectaladdin/aladdin-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/projectaladdin/aladdin-wallet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> A general-purpose EIP-7702 Chrome extension wallet (MV3). What sets it apart:
> it actually exposes `wallet_signAuthorization` and `eth_sendTransaction({authorizationList})`
> to dapps with no hardcoded delegate whitelist — every other browser wallet
> currently refuses the RPC outright or only allows their own pre-blessed
> delegates ([Curvegrid][curvegrid] · [Alchemy][alchemy]).
>
> The trade-off: arbitrary 7702 signing is risky, so the popup surfaces bold red
> warnings and forces a fresh confirmation per-request. We trust the user to
> read the prompt — same bargain MetaMask makes for `eth_sign` (and the same
> reason no other wallet has shipped 7702 yet).

**Install**: load `dist/` unpacked (see [Install (dev)](#install-dev)). A Chrome Web Store listing is pending publication.

## Features

- **EIP-7702 native** — `wallet_signAuthorization` + `eth_sendTransaction({authorizationList})`
- **Multi-chain** — Mainnet + Sepolia bundled; runtime-add any EVM chain
- **HD multi-account** — BIP-44 derivation (`m/44'/60'/0'/0/N`), rename / switch / dedicated full-screen picker; per-account [concentric-square identicon](#avatar) + native balance shown alongside
- **Token list** — native + builtin ERC-20s (USDC/USDT/DAI/WETH on mainnet, USDC on sepolia) + user-imported, USD via DefiLlama, optional "hide zero balances"
- **Send / Receive** — Send: token picker, USD live preview, EIP-1559 gas tiers (slow / normal / fast); Receive: real QR code with account identicon overlay + click-to-copy address + chain-specific warning strip
- **Custom dapp connect screen** — site favicon + per-account avatar + permission breakdown + dashed phishing warning
- **EIP-712 signing** — Permit (ERC-2612) / PermitSingle / PermitBatch (Permit2) / Seaport `OrderComponents` / `Mail` parsed with named fields + human-readable amounts; everything else falls back to a folded raw-JSON accordion
- **Auto-lock** — accurate 30 min / 1 hour / 2 hour timer that survives MV3 service-worker restarts via `chrome.storage.session`
- **Snappy refresh** — Multicall3 (`0xcA11…CA11`) with one-shot bytecode probe + per-RPC capability cache + 30 s balance cache in `chrome.storage.local`. One round-trip for any number of tokens; popup re-opens are instant
- **Connect-class request coalescing** — wagmi's parallel `wallet_requestPermissions` + `eth_requestAccounts` merge to a single popup; one click answers both
- **Toasts** — yellow / green / red toasts for every wallet event
- **Aladdin aesthetic** — neobrutalist 3 px borders + 4 px shadows, Press Start 2P display + Silkscreen captions + JetBrains Mono numerics on the dark Aladdin palette

## Project layout

```
aladdin-wallet/
├── manifest.json              MV3 manifest (storage + alarms; <all_urls>)
├── package.json               viem 2.x + react 19 + qrcode + bun bundler
├── tests/                     548 bun:test units across 38 files (no anvil deps)
│   ├── _setup/chrome-stub.ts  in-memory chrome.storage.{local,session} stub
│   ├── crypto.test.ts         vault round-trip + BIP-44 vectors + sig recover
│   ├── validators.test.ts     EIP-712 malformed cases + EIP712Domain canonical
│   ├── decoders.test.ts       calldata + Permit canonical-shape phishing
│   ├── format.test.ts         wei/token/deadline/chain rendering edge cases
│   ├── risk.test.ts           danger banner + soft-mismatch chips
│   ├── sign-mode.test.ts      sign-confirm mode classifier + action labels
│   ├── storage.test.ts        composite-key chains + token cases + vault
│   ├── auth-normalize.test.ts EIP-7702 wire→typed normaliser + RLP roundtrip
│   ├── security-engine.test.ts decision-engine rules + per-method dispatch
│   ├── seven702-gate.test.ts  delegate verification state machine
│   ├── selector-table.test.ts COMMON_TX_ABI selector coverage
│   ├── multicall-risk.test.ts nested multicall inner-call inspection
│   ├── erc20.test.ts          multicall3 detect + balance batch + dedup
│   └── … (representative subset; 38 files total)
└── src/
    ├── background.ts          MV3 service worker — RPC dispatch, sign queue,
    │                          chrome.storage.session unlock cache,
    │                          chrome.storage.local balance cache,
    │                          DefiLlama price cache, Multicall3 detection,
    │                          connect-method coalescing
    ├── content.ts             MV3 ISOLATED-world bridge (postMessage ↔
    │                          background), preserves EIP-1193 error codes
    ├── inject.ts              MV3 MAIN-world EIP-1193 provider + EIP-6963
    │                          announce + Layer 1 cache + isMetaMask shim
    ├── popup-bootstrap.tsx    popup entry (createRoot)
    ├── popup.tsx              top-level App router (welcome / unlock /
    │                          dashboard / sign-confirm) + ToastContext
    │                          provider; per-screen UI lives in
    │                          src/popup/screens/
    ├── popup/                 React screens, components, hooks
    │   ├── screens/           dashboard, send, receive, settings, sign-
    │   │                      confirm, activity, onboarding, ...
    │   ├── components/        header, security-checks, ...
    │   └── hooks/             use-clipboard, use-ens-names
    │
    ├── shared/                cross-entrypoint config + protocol (no IO)
    │   ├── config.ts          BUILTIN_NETWORKS + BUILTIN_TOKENS + WALLET_INFO
    │   ├── protocol.ts        message types popup ↔ background
    │   └── icon-data-url.ts   16×16 PNG data URL for EIP-6963 announce
    │
    ├── core/                  chrome.storage / RPC / signing (chrome-bound)
    │   ├── crypto.ts          BIP-39 + AES-GCM/PBKDF2 vault + viem sign* helpers
    │   ├── storage.ts         chrome.storage.local wrappers (vault, accounts,
    │   │                      customChains, tokens, autoLockMin, hideZero, ...)
    │   └── erc20.ts           ERC-20 ABI + Multicall3 helpers — fetchTokenMeta,
    │                          fetchTokenBalancesBatch, detectMulticallSupport
    │
    └── lib/                   pure helpers (no React/chrome — fully unit-tested)
        ├── validators.ts      EIP-712 / sendTransaction / watchAsset schema gates
        ├── decoders.ts        COMMON_TX_ABI + decodeTxData + Permit canonical-
        │                      shape recognizers + parseTyped + relativeFromUnix
        ├── format.ts          formatWeiHex / humanAmount / humanDeadline /
        │                      formatTokenAmount / chainBadge / formatCurrency
        │                      (ETH / USD dual-currency display)
        ├── risk.ts            isDangerous + inconsistencies (sign-confirm danger
        │                      banner + soft-mismatch chip classifiers)
        ├── sign-mode.ts       deriveSignMode + signActionLabel
        │                      (route SignConfirm into 5+1 visual modes)
        └── auth-normalize.ts  normalizeAuthorizationList — EIP-7702 wire-format
                               → typed-format coercion. Patches a viem two-layer
                               formatter mismatch that produced silently-skipped
                               authorizations on chain. See `tests/auth-normalize.test.ts` for the canonical roundtrip cases.
```

**Layout discipline**: `lib/` is the unit-test target (no `chrome.*` / React / RPC
allowed); `core/` is chrome-bound shared logic; `shared/` is environment-free
constants + types; the four MV3 entrypoints stay flat at `src/` root so they
match `manifest.json`'s references one-to-one.

## Tests

```sh
bun test tests/                # ~10 s, 548 tests across 38 files
bun test tests/risk.test.ts    # one file
```

All pure-logic surfaces (sign-confirm classifier, EIP-712 schema gate,
Permit canonical-shape, calldata decode, vault round-trip, composite-key
chain storage) live in dedicated modules and are unit-tested without
spinning up a browser or an RPC. End-to-end flows are covered by a
Playwright suite (`bun run test:e2e`) driving the built extension against a
local fixture dapp. See `tests/` and `e2e/` for per-file coverage.

## Install (dev)

```sh
bun install
bun run build       # one-shot → dist/
bun run watch       # fs-watch src/ → auto-rebuild
# Chrome → chrome://extensions → Developer mode → Load unpacked → select dist/
```

After code changes hit `↻` on the extension card AND close+reopen the popup
— Chrome caches both SW and popup separately. Settings shows the active
build version at the bottom for confirmation.

## Distribution build

```sh
bun run pack        # build + zip → aladdin-wallet-v<ver>.zip
```

The zip is all flat in archive root (manifest.json at the top level, as the
Chrome Web Store requires). Upload to the Chrome Web Store dashboard or hand
to a user for sideload. Bumping `manifest.json#version` is how the filename
rolls over.

## Avatar

Each account gets a deterministic [concentric-square identicon](src/popup/shared.tsx)
derived from the address (djb2 hash → two palette picks), framed with a 2 px
ink border, all on the Aladdin palette. Same address → same glyph forever, so
users build a visual memory of their accounts. Used in the connect screen,
account picker, and the Receive QR's center overlay.

---

## Contributing

This is a reference implementation, not a managed product. We welcome:
- Bug reports + reproductions — open an Issue
- Security disclosures — use GitHub's [private vulnerability reporting](https://github.com/projectaladdin/aladdin-wallet/security/advisories/new). Do NOT file exploitable vulns in public Issues. See [`SECURITY.md`](./SECURITY.md).
- Discussion of EIP-7702 / EIP-1193 / sign-confirm UX patterns

PR expectations: run `bun run verify` (audit + tsc + tests + build) locally — CI runs the same on every push. The repo enforces English-only via a CI grep guard. Default to "no refactor PRs" — this codebase has been through extensive multi-round audit; refactors land only when they eliminate a concrete bug, real dead code, or measurable performance issue.

---

## Privacy

Aladdin Wallet is self-custody and runs no developer server, analytics, or
telemetry — your keys and activity stay on your device. See [`PRIVACY.md`](./PRIVACY.md)
for the full data-handling breakdown.

## License

MIT — see [`LICENSE`](./LICENSE).

[curvegrid]: https://www.curvegrid.com/blog/2026-02-13-a-practical-look-at-eip-7702-and-wallet-delegation
[alchemy]: https://www.alchemy.com/blog/eip-7702-metamask-and-wallets
