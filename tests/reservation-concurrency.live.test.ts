import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { closeDb, initDb } from '../src/db/index.js';
import { cancelReservation, getBalance, grantCredits, reserveCredits } from '../src/ledger/index.js';

const enabled = Boolean(process.env['TEST_DATABASE_URL']);
test('live ledger serializes 100 distinct holds at one exact shared ceiling', { skip: !enabled }, async t => {
  const setup = new Pool({ connectionString: process.env['TEST_DATABASE_URL'], max: 2 });
  await setup.query(`CREATE TABLE IF NOT EXISTS organizations(organization_id text PRIMARY KEY,name text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS ledger_entries(entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,user_id text,entry_type text NOT NULL,amount numeric(20,6) NOT NULL,balance_after numeric(20,6) NOT NULL,idempotency_key text NOT NULL,correlation_id text,service text,run_id text,created_at timestamptz NOT NULL DEFAULT now(),created_by text NOT NULL,metadata jsonb NOT NULL,checksum text NOT NULL,UNIQUE(organization_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS reservations(reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id text NOT NULL,user_id text,amount numeric(20,6) NOT NULL,expires_at timestamptz NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz,cancelled_at timestamptz,correlation_id text,idempotency_key text NOT NULL,created_by text NOT NULL,UNIQUE(organization_id,idempotency_key));`);
  const url = new URL(process.env['TEST_DATABASE_URL']!); process.env['PGHOST']=url.hostname; process.env['PGPORT']=url.port; process.env['PGUSER']=decodeURIComponent(url.username); process.env['PGPASSWORD']=decodeURIComponent(url.password); process.env['PGDATABASE']=url.pathname.slice(1); process.env['DATABASE_POOL_SIZE']='50';
  const organizationId=`live-${randomUUID()}`; await setup.query("INSERT INTO organizations VALUES($1,'live','active',now())",[organizationId]); initDb();
  t.after(async()=>{await closeDb();await setup.query('DELETE FROM reservations WHERE organization_id=$1',[organizationId]);await setup.query('DELETE FROM ledger_entries WHERE organization_id=$1',[organizationId]);await setup.query('DELETE FROM organizations WHERE organization_id=$1',[organizationId]);await setup.end();});
  await grantCredits({organization_id:organizationId,amount:'100.000000',reason:'test ceiling',idempotency_key:randomUUID(),actor:'test'});
  const requests=Array.from({length:100},()=>({organization_id:organizationId,amount:'1.000000',ttl_seconds:300,idempotency_key:randomUUID(),actor:'test'}));
  const held=await Promise.all(requests.map(reserveCredits)); assert.equal(new Set(held.map(item=>item.reservation_id)).size,100);
  const boundary=await getBalance(organizationId); assert.equal(boundary.current_balance,'100.000000');assert.equal(boundary.reserved_amount,'100.000000');assert.equal(boundary.available_balance,'0.000000');
  await assert.rejects(reserveCredits({organization_id:organizationId,amount:'0.000001',ttl_seconds:300,idempotency_key:randomUUID(),actor:'test'}),/INSUFFICIENT_CREDITS|Insufficient/);
  const replay=await reserveCredits(requests[0]!); assert.equal(replay.reservation_id,held[0]!.reservation_id);
  await assert.rejects(reserveCredits({...requests[0]!,amount:'2.000000'}),/DUPLICATE_IDEMPOTENCY_KEY|Idempotency/);
  await cancelReservation(held[0]!.reservation_id,'test');
  const reconciled=await getBalance(organizationId); assert.equal(reconciled.available_balance,'1.000000');
  await reserveCredits({organization_id:organizationId,amount:'1.000000',ttl_seconds:300,idempotency_key:randomUUID(),actor:'test'});
  assert.equal((await getBalance(organizationId)).available_balance,'0.000000');
});
