import { describe, it, expect, beforeEach } from 'vitest';

// ── Replicate cost tracking logic for unit testing ──

interface MonthData {
  totalUsd: number;
  queries: number;
  sessions: string[];
  lastUpdated: string | null;
}

interface CostData {
  months: Record<string, MonthData>;
}

function createCostTracker() {
  let data: CostData = { months: {} };

  return {
    getData: () => structuredClone(data),
    reset: () => { data = { months: {} }; },
    addCost: (amount: number, sessionId?: string) => {
      const key = new Date().toISOString().slice(0, 7);
      if (!data.months[key]) {
        data.months[key] = { totalUsd: 0, queries: 0, sessions: [], lastUpdated: null };
      }
      const month = data.months[key];
      month.totalUsd = Math.round((month.totalUsd + amount) * 1e6) / 1e6;
      month.queries += 1;
      if (sessionId && !month.sessions.includes(sessionId)) {
        month.sessions.push(sessionId);
      }
      month.lastUpdated = new Date().toISOString();
      return month;
    },
    getCurrentMonth: () => {
      const key = new Date().toISOString().slice(0, 7);
      return data.months[key] || { totalUsd: 0, queries: 0, sessions: [] };
    },
  };
}

describe('cost tracking', () => {
  let tracker: ReturnType<typeof createCostTracker>;

  beforeEach(() => {
    tracker = createCostTracker();
  });

  describe('addCost', () => {
    it('creates month entry on first cost', () => {
      tracker.addCost(0.05, 'sid-1');
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(0.05);
      expect(month.queries).toBe(1);
      expect(month.sessions).toEqual(['sid-1']);
      expect(month.lastUpdated).toBeTruthy();
    });

    it('accumulates cost across multiple calls', () => {
      tracker.addCost(0.05, 'sid-1');
      tracker.addCost(0.03, 'sid-1');
      tracker.addCost(0.12, 'sid-2');
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(0.2);
      expect(month.queries).toBe(3);
    });

    it('avoids floating point drift', () => {
      // 0.1 + 0.2 should be 0.3, not 0.30000000000000004
      tracker.addCost(0.1);
      tracker.addCost(0.2);
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(0.3);
    });

    it('deduplicates sessions', () => {
      tracker.addCost(0.01, 'sid-1');
      tracker.addCost(0.02, 'sid-1');
      tracker.addCost(0.03, 'sid-1');
      const month = tracker.getCurrentMonth();
      expect(month.sessions).toEqual(['sid-1']);
    });

    it('tracks multiple unique sessions', () => {
      tracker.addCost(0.01, 'sid-1');
      tracker.addCost(0.02, 'sid-2');
      tracker.addCost(0.03, 'sid-3');
      const month = tracker.getCurrentMonth();
      expect(month.sessions).toHaveLength(3);
    });

    it('handles missing sessionId', () => {
      tracker.addCost(0.05);
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(0.05);
      expect(month.sessions).toEqual([]);
    });

    it('returns the updated month data', () => {
      const result = tracker.addCost(0.1, 'sid-1');
      expect(result.totalUsd).toBe(0.1);
      expect(result.queries).toBe(1);
    });
  });

  describe('getCurrentMonth', () => {
    it('returns zero state for empty tracker', () => {
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(0);
      expect(month.queries).toBe(0);
    });

    it('returns accumulated data after costs added', () => {
      tracker.addCost(0.5, 'a');
      tracker.addCost(1.0, 'b');
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(1.5);
      expect(month.queries).toBe(2);
    });
  });

  describe('month key format', () => {
    it('uses YYYY-MM format', () => {
      tracker.addCost(0.01);
      const data = tracker.getData();
      const keys = Object.keys(data.months);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  describe('very small costs', () => {
    it('handles sub-cent amounts', () => {
      tracker.addCost(0.0001);
      tracker.addCost(0.0002);
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBe(0.0003);
    });

    it('handles large accumulation of small costs', () => {
      for (let i = 0; i < 100; i++) {
        tracker.addCost(0.001);
      }
      const month = tracker.getCurrentMonth();
      expect(month.totalUsd).toBeCloseTo(0.1, 4);
      expect(month.queries).toBe(100);
    });
  });
});
