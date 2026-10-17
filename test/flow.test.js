// End-to-end test against the mock wallet: create invoice -> pay -> confirmed -> webhook signature ok.
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const SECRET = 'whsec-test-secret-123456';
const hooks = [];
const sink = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => { hooks.push({ b, sig: req.headers['x-bdxpay-signature'] }); res.end('ok'); });
}).listen(9099);

const srv = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, MOCK: '1', API_KEY: 'test-api-key-0123456789', PORT: '8099', POLL_SECONDS: '1',
         CONFIRMATIONS: '3', WEBHOOK_URL: 'http://127.0.0.1:9099', WEBHOOK_SECRET: SECRET, DATA_FILE: './data/test.json' },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, o = {}) => fetch('http://127.0.0.1:8099' + p, o).then(async (r) => [r.status, await r.json()]);
try {
  await sleep(800);
  assert.equal((await api('/api/invoices', { method: 'POST', body: '{"amount":"1"}' }))[0], 401);
  assert.equal((await api('/api/invoices', { method: 'POST', headers: { 'x-api-key': 'test-api-key-0123456789' }, body: '{"amount":"-1"}' }))[0], 400);
  const [c, inv] = await api('/api/invoices', { method: 'POST', headers: { 'x-api-key': 'test-api-key-0123456789' }, body: '{"amount":"12.5","orderRef":"A1"}' });
  assert.equal(c, 201); assert.equal(inv.amount, '12.5'); assert.equal(inv.status, 'pending');
  await api('/dev/pay/' + inv.id, { method: 'POST' });
  await sleep(6000);
  const [, done] = await api('/api/invoices/' + inv.id);
  assert.equal(done.status, 'confirmed');
  assert.ok(hooks.length >= 1);
  for (const h of hooks) assert.equal(h.sig, crypto.createHmac('sha256', SECRET).update(h.b).digest('hex'));
  assert.ok(!JSON.stringify(done).match(/ip|email|name/i));
  console.log('PASS: invoice -> detected -> confirmed, webhooks signed (' + hooks.length + ')');
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { srv.kill(); sink.close(); }
