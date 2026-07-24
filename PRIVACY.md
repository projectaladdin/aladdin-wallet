# Privacy Policy — Aladdin Wallet

_Last updated: 2026-07-24_

Aladdin Wallet is a self-custody browser wallet. It is designed so that **your
keys and your activity stay on your own device**. We (the developer) do not run
a server, do not operate any analytics or telemetry, and never receive, store,
or sell your data.

## What the extension stores — locally, on your device

The following are kept only in your browser's extension storage
(`chrome.storage.local` / `chrome.storage.session`) and never transmitted to us:

- Your **encrypted key vault** — your seed phrase and private keys, encrypted
  with AES-GCM using a key derived from your password (PBKDF2). The plaintext
  seed/keys never leave the device and are never sent anywhere.
- Your **accounts** (addresses, labels), **selected network**, **custom chains**
  you add, **imported token list**, and **preferences** (auto-lock timer,
  hide-zero-balances, currency display).
- A short-lived **unlock state** so the popup can reopen without re-entering your
  password until the auto-lock timer elapses.

Uninstalling the extension, or using its reset function, removes this data.

## Data sent to third parties you interact with

To function as a wallet, the extension contacts external services **that you
choose** by using it. These requests go directly from your browser to those
services — not to us:

- **RPC endpoints** (the built-in networks, and any custom RPC you add): receive
  the requests needed to read balances and broadcast the transactions you
  approve. These include your account addresses and the transaction data you
  sign.
- **Price data (DefiLlama)**: token contract addresses are sent to fetch USD
  prices for your token list.
- **NFT metadata & images (IPFS gateways and token-URI hosts)**: contacted to
  display NFTs you hold.
- **Contract source verification (Sourcify)**: contract addresses are sent to
  show verification status during signing.
- **Site icons (Google's favicon service)**: the domain of a dapp you connect to
  is sent to display its icon on the connection screen.

Each of these third parties has its own privacy policy. The extension sends them
only what is technically required for the feature above, and only when you use
that feature.

## What we do NOT do

- We do not collect, receive, or store any of your personal data.
- We do not use analytics, tracking, advertising, or fingerprinting.
- We do not sell or share data with anyone.
- We never transmit your seed phrase, private keys, or password anywhere.

## Permissions

- `storage` — save your encrypted vault and settings on your device.
- `alarms` — run the auto-lock timer reliably.
- Host access (all sites) — inject the wallet provider so dapps on any site can
  request a connection, and let the background worker reach the RPC/metadata
  hosts above. The extension does not read or exfiltrate page content.

## Contact

Questions about this policy: **<your-contact-email>** (replace before publishing),
or open an issue on the project's GitHub repository.
