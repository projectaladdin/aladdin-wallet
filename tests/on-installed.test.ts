// Regression guard for the chain-choice-clobbered-on-reload bug. The
// onInstalled listener used to unconditionally seed
// setCurrentChainId(DEFAULT_CHAIN_ID), which fired on EVERY chrome
// runtime reload (reason='update') and silently reset the user's
// chain choice. Gated to reason==='install' only.

import { describe, it, expect, beforeEach } from 'bun:test';
import { installChromeStub } from './_setup/chrome-stub';
import { DEFAULT_CHAIN_ID } from '../src/shared/config';

beforeEach(() => {
  installChromeStub();
});

describe('seedActiveChainOnInstall', () => {
  it('reason=install seeds DEFAULT_CHAIN_ID when storage is empty', async () => {
    const { seedActiveChainOnInstall } = await import('../src/core/on-installed');
    const { getCurrentChainId } = await import('../src/core/storage');
    await seedActiveChainOnInstall('install');
    expect(await getCurrentChainId()).toBe(DEFAULT_CHAIN_ID);
  });

  it('reason=update does NOT overwrite an existing chain choice', async () => {
    const { seedActiveChainOnInstall } = await import('../src/core/on-installed');
    const { setCurrentChainId, getCurrentChainId } = await import('../src/core/storage');
    // User had previously switched to mainnet.
    await setCurrentChainId(1);
    // Dev reload at chrome://extensions/ fires onInstalled('update').
    await seedActiveChainOnInstall('update');
    // Chain choice is preserved.
    expect(await getCurrentChainId()).toBe(1);
  });

  it('reason=chrome_update / shared_module_update also leave storage alone', async () => {
    const { seedActiveChainOnInstall } = await import('../src/core/on-installed');
    const { setCurrentChainId, getCurrentChainId } = await import('../src/core/storage');
    await setCurrentChainId(11155111); // sepolia
    await seedActiveChainOnInstall('chrome_update');
    expect(await getCurrentChainId()).toBe(11155111);
    await seedActiveChainOnInstall('shared_module_update');
    expect(await getCurrentChainId()).toBe(11155111);
  });

  it('reason=install on top of an existing chain DOES overwrite (fresh-install semantics)', async () => {
    // This branch is the only one that writes to storage. It models a
    // user wiping their profile dir and re-installing — pre-existing
    // storage would already be empty in that case, but the contract
    // still applies symmetrically.
    const { seedActiveChainOnInstall } = await import('../src/core/on-installed');
    const { setCurrentChainId, getCurrentChainId } = await import('../src/core/storage');
    await setCurrentChainId(137);
    await seedActiveChainOnInstall('install');
    expect(await getCurrentChainId()).toBe(DEFAULT_CHAIN_ID);
  });
});
