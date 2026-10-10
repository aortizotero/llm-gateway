export interface BreakerConfig {
  window: number; // outcomes remembered per hop
  minFailures: number; // failures in the window before it may open
  failureRate: number; // 0..1, failure share in the window that opens it
  openMs: number; // how long it stays open before a probe is allowed
}

type State = 'closed' | 'open' | 'half-open';

interface Circuit {
  state: State;
  outcomes: boolean[]; // true = failure
  openedAt: number;
  probing: boolean;
}

// One circuit per "provider:model". In memory on purpose: losing it on restart only costs a few probes.
export function createBreakers(config: BreakerConfig, now: () => number = Date.now) {
  const circuits = new Map<string, Circuit>();

  const get = (key: string): Circuit => {
    let c = circuits.get(key);
    if (!c) circuits.set(key, (c = { state: 'closed', outcomes: [], openedAt: 0, probing: false }));
    return c;
  };

  const open = (c: Circuit) => {
    c.state = 'open';
    c.openedAt = now();
    c.probing = false;
  };

  return {
    // Half-open lets exactly one probe through; everyone else keeps skipping until it resolves.
    canPass(key: string): boolean {
      const c = get(key);
      if (c.state === 'open' && now() - c.openedAt >= config.openMs) c.state = 'half-open';
      if (c.state === 'closed') return true;
      if (c.state === 'half-open' && !c.probing) {
        c.probing = true;
        return true;
      }
      return false;
    },

    success(key: string): void {
      const c = get(key);
      if (c.state === 'half-open') {
        c.state = 'closed';
        c.outcomes = [];
        c.probing = false;
        return;
      }
      c.outcomes.push(false);
      if (c.outcomes.length > config.window) c.outcomes.shift();
    },

    failure(key: string): void {
      const c = get(key);
      if (c.state === 'half-open') return open(c);
      c.outcomes.push(true);
      if (c.outcomes.length > config.window) c.outcomes.shift();
      const failures = c.outcomes.filter(Boolean).length;
      if (failures >= config.minFailures && failures / c.outcomes.length >= config.failureRate) open(c);
    },

    // The provider answered but the request itself was bad: says nothing about health.
    neutral(key: string): void {
      get(key).probing = false;
    },

    states(): Record<string, State> {
      return Object.fromEntries([...circuits].map(([k, c]) => [k, c.state]));
    },
  };
}

export type Breakers = ReturnType<typeof createBreakers>;
