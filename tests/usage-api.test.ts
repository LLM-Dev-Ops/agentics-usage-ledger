/**
 * Tests for the simple usage API endpoints
 * Tests the /v1/usage/* endpoints
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

// Mock database pool
const mockPool = {
  query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    // Mock responses based on query pattern
    if (sql.includes('SELECT') && sql.includes('FROM accounts')) {
      return {
        rows: [{
          id: '123e4567-e89b-12d3-a456-426614174000',
          org_id: 'default',
          total_credits: 10000,
          credits_used: 500,
          credits_remaining: 9500,
          currency: 'credits',
          created_at: new Date(),
          updated_at: new Date(),
        }],
      };
    }
    if (sql.includes('SUM(credits_used)')) {
      return { rows: [{ total: '100' }] };
    }
    if (sql.includes('COUNT(*)')) {
      return { rows: [{ count: '5' }] };
    }
    if (sql.includes('FROM usage_history') && sql.includes('ORDER BY')) {
      return {
        rows: [
          {
            id: '123e4567-e89b-12d3-a456-426614174001',
            org_id: 'default',
            user_id: null,
            action: 'api_call',
            credits_used: 10,
            command: 'test',
            correlation_id: null,
            metadata: null,
            created_at: new Date(),
          },
        ],
      };
    }
    if (sql.includes('INSERT INTO accounts')) {
      return {
        rows: [{
          id: '123e4567-e89b-12d3-a456-426614174000',
          org_id: 'default',
          total_credits: 10000,
          credits_used: 0,
          credits_remaining: 10000,
          currency: 'credits',
          created_at: new Date(),
          updated_at: new Date(),
        }],
      };
    }
    if (sql.includes('INSERT INTO usage_history')) {
      return { rows: [{ id: '123e4567-e89b-12d3-a456-426614174002' }] };
    }
    if (sql.includes('UPDATE accounts')) {
      return { rows: [] };
    }
    return { rows: [] };
  },
  connect: async () => ({
    query: mockPool.query,
    release: () => {},
  }),
};

// Inject mock pool
import { setPool } from '../src/db/index.js';
setPool(mockPool as never);

// Import functions after mocking
import {
  getBalance,
  getUsageSummary,
  getUsageHistory,
  recordUsage,
} from '../src/db/usage.js';

describe('Usage API', () => {
  describe('getBalance', () => {
    it('should return balance information', async () => {
      const balance = await getBalance('default');

      assert.strictEqual(balance.org_id, 'default');
      assert.strictEqual(typeof balance.current_balance, 'number');
      assert.strictEqual(typeof balance.credits_remaining, 'number');
      assert.strictEqual(typeof balance.credits_used, 'number');
      assert.strictEqual(typeof balance.total_credits, 'number');
      assert.strictEqual(balance.currency, 'credits');
      assert.ok(balance.last_updated);
    });
  });

  describe('getUsageSummary', () => {
    it('should return usage summary with daily/monthly stats', async () => {
      const summary = await getUsageSummary('default');

      assert.strictEqual(summary.org_id, 'default');
      assert.strictEqual(typeof summary.balance, 'number');
      assert.strictEqual(typeof summary.daily_usage, 'number');
      assert.strictEqual(typeof summary.monthly_usage, 'number');
    });
  });

  describe('getUsageHistory', () => {
    it('should return paginated history', async () => {
      const result = await getUsageHistory('default', 50, 0);

      assert.ok(Array.isArray(result.history));
      assert.ok(result.pagination);
      assert.strictEqual(typeof result.pagination.offset, 'number');
      assert.strictEqual(typeof result.pagination.limit, 'number');
      assert.strictEqual(typeof result.pagination.total, 'number');
    });

    it('should respect limit parameter', async () => {
      const result = await getUsageHistory('default', 10, 0);

      assert.ok(result.pagination.limit <= 10);
    });
  });

  describe('recordUsage', () => {
    it('should record usage and return success', async () => {
      const result = await recordUsage({
        org_id: 'default',
        action: 'test_action',
        credits_used: 5,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.id);
    });
  });
});

console.log('\n========================================');
console.log('Usage API Test Suite');
console.log('========================================\n');
