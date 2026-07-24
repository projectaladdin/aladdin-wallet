// Minimal chrome.storage.{local,session} stub for unit tests. Implements
// just what storage.ts touches: get(key, cb), set(obj, cb), remove(key,
// cb). Each callback fires via queueMicrotask so the production
// promisified wrappers in storage.ts behave the same shape as in MV3
// (microtask-deferred, never sync-resolved).
//
// Two stores: `local` (persistent — vault, currency, etc.) and
// `session` (cleared on browser close in real MV3 — the home of
// `allowUnverifiedDelegate` and any future security-scoped flag).

type StoreMap = Record<string, unknown>;

class ChromeStorageStub {
  store: StoreMap = {};

  reset() {
    this.store = {};
  }

  get(keys: string | string[] | null | Record<string, unknown>, cb: (out: StoreMap) => void) {
    queueMicrotask(() => {
      if (keys === null || keys === undefined) {
        cb({ ...this.store });
        return;
      }
      if (typeof keys === 'string') {
        cb(keys in this.store ? { [keys]: this.store[keys] } : {});
        return;
      }
      if (Array.isArray(keys)) {
        const out: StoreMap = {};
        for (const k of keys) if (k in this.store) out[k] = this.store[k];
        cb(out);
        return;
      }
      // Object form: keys are defaults — return value if set, else default.
      const out: StoreMap = {};
      for (const [k, dflt] of Object.entries(keys)) out[k] = k in this.store ? this.store[k] : dflt;
      cb(out);
    });
  }

  set(obj: StoreMap, cb: () => void) {
    queueMicrotask(() => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) delete this.store[k];
        else this.store[k] = v;
      }
      cb();
    });
  }

  remove(keys: string | string[], cb: () => void) {
    queueMicrotask(() => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete this.store[k];
      cb();
    });
  }
}

export const chromeStorageStub = new ChromeStorageStub();
export const chromeSessionStub = new ChromeStorageStub();

/** Install the stub on globalThis.chrome. Call once before importing storage.ts.
 *  Returns the local-area stub so tests can `.reset()` between cases.
 *  Use `chromeSessionStub` directly to interact with session storage. */
export function installChromeStub(): ChromeStorageStub {
  chromeStorageStub.reset();
  chromeSessionStub.reset();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: chromeStorageStub.get.bind(chromeStorageStub),
        set: chromeStorageStub.set.bind(chromeStorageStub),
        remove: chromeStorageStub.remove.bind(chromeStorageStub),
      },
      session: {
        get: chromeSessionStub.get.bind(chromeSessionStub),
        set: chromeSessionStub.set.bind(chromeSessionStub),
        remove: chromeSessionStub.remove.bind(chromeSessionStub),
      },
    },
    runtime: {
      lastError: null,
      // No-op listener registries — tests that import a file which
      // calls `chrome.runtime.onMessage.addListener(...)` at module
      // top-level shouldn't crash. Real handler behavior is exercised
      // via e2e; unit tests pin pure logic.
      onMessage: {
        addListener: (_fn: unknown) => {},
        removeListener: (_fn: unknown) => {},
      },
      onConnect: {
        addListener: (_fn: unknown) => {},
        removeListener: (_fn: unknown) => {},
      },
      onInstalled: {
        addListener: (_fn: unknown) => {},
        removeListener: (_fn: unknown) => {},
      },
      sendMessage: (_msg: unknown, cb?: (resp: unknown) => void) => {
        if (cb) queueMicrotask(() => cb({ ok: false, error: 'chrome.runtime.sendMessage stub' }));
      },
    },
    tabs: {
      query: (_q: unknown, cb?: (tabs: unknown[]) => void) => {
        if (cb) queueMicrotask(() => cb([]));
        return Promise.resolve([]);
      },
      sendMessage: (_tabId: number, _msg: unknown) => Promise.resolve(),
    },
    action: {
      setBadgeText: (_args: unknown, cb?: () => void) => {
        if (cb) queueMicrotask(cb);
        return Promise.resolve();
      },
      setBadgeBackgroundColor: (_args: unknown) => Promise.resolve(),
    },
    alarms: {
      create: (_name: string, _info: unknown) => {},
      clear: (_name: string, cb?: (cleared: boolean) => void) => {
        if (cb) queueMicrotask(() => cb(true));
      },
      onAlarm: { addListener: (_fn: unknown) => {} },
    },
  };
  return chromeStorageStub;
}
