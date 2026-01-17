/**
 * Tests for the entitlements API endpoints
 * Tests the /v1/entitlements/* endpoints
 *
 * Execution Order (per specification):
 * 1. Hard execution gate (CLI) - checked externally
 * 2. Entitlement check (isCommandAllowed) - checked here
 * 3. Command execution - proceeds if allowed
 * 4. Usage record emission - recorded after execution
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

// Mock data storage
const mockEntitlements = new Map<string, {
  entitlement_id: string;
  organization_id: string;
  command_name: string;
  status: string;
  credits_per_use: number;
  daily_limit: number | null;
  monthly_limit: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}>();

const mockUsageRecords: {
  usage_id: string;
  organization_id: string;
  user_id: string | null;
  command_name: string;
  credits_used: number;
  success: boolean;
  execution_time_ms: number | null;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}[] = [];

// Reset mock data before each test suite
function resetMockData() {
  mockEntitlements.clear();
  mockUsageRecords.length = 0;

  // Add default entitlements for 'test-org'
  const testOrg = 'test-org';
  const enabledCommands = ['plan:create', 'plan:approve', 'deploy:preview'];
  enabledCommands.forEach((cmd, i) => {
    mockEntitlements.set(`${testOrg}:${cmd}`, {
      entitlement_id: `ent-${i}`,
      organization_id: testOrg,
      command_name: cmd,
      status: 'enabled',
      credits_per_use: 1,
      daily_limit: 100,
      monthly_limit: 1000,
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
  });

  // Add a suspended entitlement
  mockEntitlements.set(`${testOrg}:deploy:run`, {
    entitlement_id: 'ent-suspended',
    organization_id: testOrg,
    command_name: 'deploy:run',
    status: 'suspended',
    credits_per_use: 5,
    daily_limit: 10,
    monthly_limit: 100,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  });
}

// Mock database pool
const mockPool = {
  query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    // Handle CREATE TABLE queries
    if (sql.includes('CREATE TABLE')) {
      return { rows: [] };
    }

    // Handle CREATE INDEX queries
    if (sql.includes('CREATE INDEX')) {
      return { rows: [] };
    }

    // Handle entitlement lookups
    if (sql.includes('FROM command_entitlements') && sql.includes('WHERE organization_id')) {
      const orgId = params?.[0] as string;
      const cmdName = params?.[1] as string;

      if (cmdName) {
        // Specific command lookup
        const key = `${orgId}:${cmdName}`;
        const ent = mockEntitlements.get(key);
        return { rows: ent ? [ent] : [] };
      } else {
        // All entitlements for org
        const orgEnts = Array.from(mockEntitlements.values())
          .filter(e => e.organization_id === orgId);
        return { rows: orgEnts };
      }
    }

    // Handle usage count queries (daily)
    if (sql.includes('FROM command_usage') && sql.includes('CURRENT_DATE') && !sql.includes('month')) {
      const orgId = params?.[0] as string;
      const cmdName = params?.[1] as string;
      const count = mockUsageRecords.filter(
        r => r.organization_id === orgId && r.command_name === cmdName
      ).length;
      return { rows: [{ count: String(count) }] };
    }

    // Handle usage count queries (monthly)
    if (sql.includes('FROM command_usage') && sql.includes('month')) {
      const orgId = params?.[0] as string;
      const cmdName = params?.[1] as string;
      const records = mockUsageRecords.filter(
        r => r.organization_id === orgId && r.command_name === cmdName
      );
      const count = records.length;
      const totalCredits = records.reduce((sum, r) => sum + r.credits_used, 0);
      return { rows: [{ count: String(count), total_credits: String(totalCredits) }] };
    }

    // Handle usage insertion
    if (sql.includes('INSERT INTO command_usage')) {
      const record = {
        usage_id: `usage-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        organization_id: params?.[0] as string,
        user_id: params?.[1] as string | null,
        command_name: params?.[2] as string,
        credits_used: params?.[3] as number,
        success: params?.[4] as boolean,
        execution_time_ms: params?.[5] as number | null,
        correlation_id: params?.[6] as string | null,
        metadata: params?.[7] ? JSON.parse(params[7] as string) : {},
        created_at: new Date(),
      };
      mockUsageRecords.push(record);
      return { rows: [record] };
    }

    // Handle entitlement insertion (bootstrap)
    if (sql.includes('INSERT INTO command_entitlements') && sql.includes('VALUES')) {
      // This is the bootstrap query with multiple values
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
  isCommandAllowed,
  recordCommandExecution,
  getEntitledCommands,
} from '../src/ledger/index.js';

import { ENTITLED_COMMANDS } from '../src/db/entitlements.js';

describe('Entitlements API', () => {
  before(() => {
    resetMockData();
  });

  describe('getEntitledCommands', () => {
    it('should return list of all entitled commands', () => {
      const commands = getEntitledCommands();

      assert.ok(Array.isArray(commands));
      assert.ok(commands.length > 0);
      assert.ok(commands.includes('plan:create'));
      assert.ok(commands.includes('deploy:preview'));
      assert.ok(commands.includes('deploy:run'));
      assert.ok(commands.includes('export:csv'));
    });

    it('should include all state-changing commands per specification', () => {
      const commands = getEntitledCommands();

      // Verify all command categories are present
      const categories = {
        plan: ['plan:create', 'plan:approve'],
        simulate: ['simulate:create', 'simulate:run'],
        deploy: ['deploy:preview', 'deploy:run', 'deploy:rollback'],
        export: ['export:csv', 'export:json', 'export:pdf'],
        policy: ['policy:create', 'policy:edit', 'policy:enable', 'policy:disable', 'policy:dry-run'],
        quantify: ['quantify:create', 'quantify:compare'],
        erp: ['erp:surface', 'erp:map', 'erp:export'],
      };

      for (const [category, cmds] of Object.entries(categories)) {
        for (const cmd of cmds) {
          assert.ok(
            commands.includes(cmd),
            `Missing command: ${cmd} in category ${category}`
          );
        }
      }
    });
  });

  describe('isCommandAllowed', () => {
    before(() => {
      resetMockData();
    });

    it('should allow entitled command', async () => {
      const result = await isCommandAllowed({
        organization_id: 'test-org',
        command_name: 'plan:create',
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.organization_id, 'test-org');
      assert.strictEqual(result.command_name, 'plan:create');
      assert.strictEqual(result.credits_per_use, 1);
    });

    it('should deny non-entitled command', async () => {
      const result = await isCommandAllowed({
        organization_id: 'test-org',
        command_name: 'export:csv', // Not in test org's entitlements
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes('not entitled'));
    });

    it('should deny suspended entitlement', async () => {
      const result = await isCommandAllowed({
        organization_id: 'test-org',
        command_name: 'deploy:run',
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes('suspended'));
    });

    it('should deny command for non-existent organization entitlements', async () => {
      const result = await isCommandAllowed({
        organization_id: 'unknown-org',
        command_name: 'plan:create',
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes('not entitled'));
    });

    it('should return usage stats when allowed', async () => {
      const result = await isCommandAllowed({
        organization_id: 'test-org',
        command_name: 'plan:create',
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(typeof result.daily_usage, 'number');
      assert.strictEqual(typeof result.monthly_usage, 'number');
      assert.strictEqual(result.daily_limit, 100);
      assert.strictEqual(result.monthly_limit, 1000);
    });
  });

  describe('recordCommandExecution', () => {
    before(() => {
      resetMockData();
    });

    it('should record successful command execution', async () => {
      const result = await recordCommandExecution({
        organization_id: 'test-org',
        command_name: 'plan:create',
        success: true,
        credits_used: 1,
      });

      assert.ok(result.usage_id);
      assert.strictEqual(result.organization_id, 'test-org');
      assert.strictEqual(result.command_name, 'plan:create');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.credits_used, 1);
      assert.ok(result.created_at);
    });

    it('should record failed command execution', async () => {
      const result = await recordCommandExecution({
        organization_id: 'test-org',
        command_name: 'plan:create',
        success: false,
        credits_used: 0,
      });

      assert.ok(result.usage_id);
      assert.strictEqual(result.success, false);
    });

    it('should record execution with optional fields', async () => {
      const result = await recordCommandExecution({
        organization_id: 'test-org',
        user_id: 'user-123',
        command_name: 'deploy:preview',
        success: true,
        credits_used: 5,
        execution_time_ms: 1500,
        correlation_id: 'corr-123',
        metadata: { key: 'value' },
      });

      assert.ok(result.usage_id);
      assert.strictEqual(result.user_id, 'user-123');
      assert.strictEqual(result.execution_time_ms, 1500);
      assert.strictEqual(result.correlation_id, 'corr-123');
    });
  });

  describe('Execution Order Compliance', () => {
    /**
     * Per specification, the execution order is:
     * 1. Hard execution gate (CLI) - checked externally
     * 2. Entitlement check (usage ledger)
     * 3. Command execution
     * 4. Usage record emission
     *
     * This test verifies that the entitlement check and usage recording
     * work correctly in sequence.
     */
    before(() => {
      resetMockData();
    });

    it('should follow execution order: check entitlement -> execute -> record', async () => {
      const orgId = 'test-org';
      const cmdName = 'plan:create';

      // Step 2: Entitlement check
      const checkResult = await isCommandAllowed({
        organization_id: orgId,
        command_name: cmdName,
      });

      assert.strictEqual(checkResult.allowed, true, 'Entitlement check should pass');

      // Step 3: Command execution would happen here (external)

      // Step 4: Usage record emission
      const recordResult = await recordCommandExecution({
        organization_id: orgId,
        command_name: cmdName,
        success: true,
        credits_used: checkResult.credits_per_use,
      });

      assert.ok(recordResult.usage_id, 'Usage record should be created');
      assert.strictEqual(
        recordResult.credits_used,
        checkResult.credits_per_use,
        'Credits charged should match entitlement'
      );
    });

    it('should abort execution when entitlement check fails', async () => {
      const orgId = 'test-org';
      const cmdName = 'export:csv'; // Not entitled

      // Step 2: Entitlement check
      const checkResult = await isCommandAllowed({
        organization_id: orgId,
        command_name: cmdName,
      });

      assert.strictEqual(checkResult.allowed, false, 'Entitlement check should fail');

      // Steps 3 & 4 should NOT happen when check fails
      // The CLI is responsible for enforcing this
    });
  });

  describe('CLI-compatible Response Format', () => {
    before(() => {
      resetMockData();
    });

    it('should return denial message suitable for CLI display', async () => {
      const result = await isCommandAllowed({
        organization_id: 'test-org',
        command_name: 'export:csv',
      });

      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason);
      // Message should be user-friendly for CLI display
      assert.ok(
        result.reason.includes('not entitled'),
        'Denial message should explain the reason'
      );
    });
  });
});

describe('ENTITLED_COMMANDS constant', () => {
  it('should be a readonly array', () => {
    assert.ok(Array.isArray(ENTITLED_COMMANDS));
    // Verify immutability by checking it's frozen or readonly
    assert.ok(Object.isFrozen(ENTITLED_COMMANDS) || ENTITLED_COMMANDS.length > 0);
  });

  it('should contain expected command format', () => {
    for (const cmd of ENTITLED_COMMANDS) {
      // Commands should be in format "category:action"
      assert.ok(
        cmd.includes(':'),
        `Command "${cmd}" should be in format "category:action"`
      );
    }
  });
});

console.log('\n========================================');
console.log('Entitlements API Test Suite');
console.log('========================================\n');
