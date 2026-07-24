# Security Policy

## Reporting a Vulnerability

**Please do not file exploitable security issues in public Issues.**

Use GitHub's private vulnerability reporting instead:

→ <https://github.com/projectaladdin/aladdin-wallet/security/advisories/new>

We aim to acknowledge reports within 72 hours. Severe issues (loss of funds, key extraction, signature forgery, vault decryption) get prioritized over UX or low-severity findings.

## Supported Versions

Only the latest published release receives security fixes. There is no LTS branch — upgrade to the latest version from the Chrome Web Store (listing pending review) or the latest [GitHub Release](https://github.com/projectaladdin/aladdin-wallet/releases).

## Scope

In scope:

- The published Chrome extension and its source code in this repo

Out of scope:

- Third-party RPC endpoints, DefiLlama, Sourcify, IPFS gateways, Google favicon, or any other external service the wallet calls (report to the respective operator)
- Browser/Chromium bugs (report to <https://crbug.com>)
- Dapp-side vulnerabilities (report to the dapp)
- Social engineering of users to confirm a transaction — the wallet's job is to surface risk; the user's job is to read the prompt

## Disclosure

We prefer coordinated disclosure: please give us a reasonable window to ship a fix before publicizing. We will credit reporters in the release notes unless anonymity is requested.

Public discussion of unfixed exploitable vulnerabilities — on Twitter, Discord, Telegram, or anywhere else — increases the risk to real users with funds stored in the wallet. Please don't.
