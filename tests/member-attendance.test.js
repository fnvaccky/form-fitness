import test from 'node:test';
import assert from 'node:assert/strict';
import {paidCoverage} from '../src/member-attendance.js';

const invoice=(changes={})=>({id:'invoice',amount_cents:89900,paid_cents:89900,membership:{start_date:'2026-10-01',end_date:'2026-10-30'},...changes});
const payment=(changes={})=>({id:'payment',invoice_id:'invoice',amount_cents:89900,created_at:'2026-10-01T00:00:00Z',...changes});

test('coverage begins only when cumulative full payment is recorded, using Manila business date',()=>{
  const invoices=[invoice()],payments=[payment({id:'last',amount_cents:39900,created_at:'2026-10-12T16:05:00Z'}),payment({id:'first',amount_cents:50000,created_at:'2026-10-02T02:00:00Z'})];
  const before=structuredClone({invoices,payments});
  assert.deepEqual(paidCoverage(invoices,payments),{coverage:[{start:'2026-10-13',end:'2026-10-30'}],unconfirmedCoverage:false});
  assert.deepEqual({invoices,payments},before,'deriving coverage does not rewrite payments or invoices');
});

test('an early payment never moves coverage before the purchased membership start',()=>{
  assert.deepEqual(paidCoverage([invoice({membership:{start_date:'2026-10-20',end_date:'2026-11-18'}})],[payment()]),{
    coverage:[{start:'2026-10-20',end:'2026-11-18'}],unconfirmedCoverage:false});
});

test('unpaid invoices do not grant coverage even when separate payment rows are supplied',()=>{
  for(const paid_cents of [0,50000])assert.deepEqual(paidCoverage([invoice({paid_cents})],[payment()]),{coverage:[],unconfirmedCoverage:false});
  for(const amount_cents of [0,-1,'89900',Infinity])assert.deepEqual(paidCoverage([invoice({amount_cents})],[payment()]),{coverage:[],unconfirmedCoverage:false});
});

test('fully paid balances without reliable confirming payment records remain unknown',()=>{
  for(const payments of [[],[payment({invoice_id:'other-invoice'})],[payment({amount_cents:50000})],[payment({amount_cents:-89900})],[payment({amount_cents:'89900'})],[payment({created_at:'invalid'})]]) {
    assert.deepEqual(paidCoverage([invoice()],payments),{coverage:[],unconfirmedCoverage:true});
  }
});

test('coverage is independently derived per invoice and uses recorded time, never nominal backdated payment date',()=>{
  const invoices=[invoice(),invoice({id:'other',membership:{start_date:'2026-11-01',end_date:'2026-11-30'}})];
  const payments=[payment({created_at:'2026-10-15T16:30:00Z',payment_date:'2026-10-01'}),payment({invoice_id:'other',created_at:'2026-10-20T01:00:00Z'})];
  assert.deepEqual(paidCoverage(invoices,payments),{coverage:[{start:'2026-10-16',end:'2026-10-30'},{start:'2026-11-01',end:'2026-11-30'}],unconfirmedCoverage:false});
});
