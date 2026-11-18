/**
 * One tab per account in a browser. Tabs of the same browser share the account's keys and
 * message store, so two running at once would each apply every incoming change: a reaction
 * (a toggle) then cancels itself, and two copies of the group keys could fall out of step.
 * The Web Locks API gives the lock to one tab; another tab can take it over ("Use here"),
 * and the tab that loses it stops.
 */
const STEAL_FLAG = 'kh.takeOverTab';

export type TabLock = { held: true; release: () => void } | { held: false };

export function acquireTabLock(account: string, onLost: () => void): Promise<TabLock> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve({ held: true, release: () => undefined });
  let steal = false;
  try {
    steal = sessionStorage.getItem(STEAL_FLAG) === '1';
    sessionStorage.removeItem(STEAL_FLAG);
  } catch {
    /* storage blocked: just ask normally */
  }
  return new Promise<TabLock>((resolve) => {
    let release = () => undefined as void;
    const kept = new Promise<void>((r) => (release = r));
    const opts: LockOptions = steal ? { steal: true } : { ifAvailable: true };
    locks
      .request(`keyhold-chat:${account}`, opts, async (lock) => {
        if (!lock) {
          resolve({ held: false });
          return;
        }
        resolve({ held: true, release });
        await kept;
      })
      // Rejected when another tab steals the lock.
      .catch(() => onLost());
  });
}

/** Reload this tab and take the lock from the other one. */
export function takeOverTab() {
  try {
    sessionStorage.setItem(STEAL_FLAG, '1');
  } catch {
    /* without storage the reload asks normally */
  }
  location.reload();
}
