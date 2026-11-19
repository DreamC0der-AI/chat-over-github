// What a browser gives the app, for running it under Node. Loaded before any test imports it.
import 'fake-indexeddb/auto';

const g = globalThis as Record<string, unknown>;
// The sync schedule never comes due by itself: scenarios run each sync step explicitly
// (Session.syncNow), so what happens depends on the steps, not on how fast the machine is.
g.__syncScale = 1e6;
g.window = globalThis;
g.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
g.location = { origin: 'http://mock.test', href: 'http://mock.test/', hash: '', search: '', pathname: '/' };
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
