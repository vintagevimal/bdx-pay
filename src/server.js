import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WalletRpc, MockRpc } from './rpc.js';
import { Store } from './store.js';

const env = process.env;
const cfg = {
  port: +env.PORT || 8080,
  host: env.HOST || '127.0.0.1',
  apiKey: env.API_KEY || '',
  webhookUrl: env.WEBHOOK_URL || '',
  webhookSecret: env.WEBHOOK_SECRET || '',
  rpcUrl: env.WALLET_RPC_URL || 'http://127.0.0.1:19091', // must be local-only
  atomic: BigInt(env.ATOMIC_UNITS || '1000000000'), // atomic units per BDX: VERIFY for your build
  confirmations: +env.CONFIRMATIONS || 10,
  ttlMs: (+env.INVOICE_TTL_MIN || 60) * 60000,
  retentionMs: (+env.RETENTION_HOURS || 24) * 3600000,
  pollMs: (+env.POLL_SECONDS || 15) * 1000,
  mock: env.MOCK === '1',
  dataFile: env.DATA_FILE || './data/invoices.json',
};
if (cfg.apiKey.length < 16) {
  console.error('Set API_KEY to a random string of at least 16 characters.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const store = new Store(cfg.dataFile);
const rpc = cfg.mock ? new MockRpc() : new WalletRpc(cfg.rpcUrl);
const decimals = String(cfg.atomic).length - 1;

// ---- amounts: integer math only (never floats for money) ----
function toAtomic(str) {
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(str));
  if (!m || (m[2] && m[2].length > decimals)) return null;
  const v = BigInt(m[1]) * cfg.atomic + BigInt((m[2] || '').padEnd(decimals, '0') || '0');
  return v > 0n ? v : null;
}
function fmt(atomic) {
  const a = BigInt(atomic);
  const frac = (a % cfg.atomic).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (a / cfg.atomic).toString() + (frac ? '.' + frac : '');
}

// ---- webhook (HMAC-signed, no customer data) ----
async function webhook(inv) {
  if (!cfg.webhookUrl) return;
  const body = JSON.stringify({
    event: 'invoice.' + inv.status,
    id: inv.id,
    orderRef: inv.orderRef,
    status: inv.status,
    amount: fmt(inv.amountAtomic),
  });
  const sig = crypto.createHmac('sha256', cfg.webhookSecret).update(body).digest('hex');
  try {
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bdxpay-signature': sig },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('webhook failed:', e.message);
  }
}

function setStatus(inv, status) {
  inv.status = status;
  if (status === 'confirmed' || status === 'expired') inv.closedAt = Date.now();
  store.put(inv);
  return webhook(inv);
}

// ---- payment watcher ----
async function tick() {
  try {
    for (const i of store.open()) if (i.status === 'pending' && Date.now() > i.expiresAt) await setStatus(i, 'expired');
    const live = store.open();
    if (!live.length) return;
    const res = await rpc.getTransfers(live.map((i) => i.minor));
    const txs = [...(res.in || []), ...(res.pool || [])];
    for (const i of live) {
      const mine = txs.filter((t) => t.subaddr_index?.minor === i.minor);
      const total = mine.reduce((s, t) => s + BigInt(t.amount), 0n);
      i.receivedAtomic = total.toString();
      if (total < BigInt(i.amountAtomic)) continue; // underpaid: keep waiting
      i.confirmations = Math.min(...mine.map((t) => t.confirmations || 0));
      if (i.confirmations >= cfg.confirmations) await setStatus(i, 'confirmed');
      else if (i.status === 'pending') await setStatus(i, 'detected');
      else store.put(i);
    }
  } catch (e) {
    console.error('watcher error:', e.message);
  }
}
setInterval(tick, cfg.pollMs);
setInterval(() => store.purge(cfg.retentionMs), 3600000);

// ---- http ----
const SECURITY = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { ...SECURITY, 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function authed(req) {
  const a = Buffer.from(req.headers['x-api-key'] || '');
  const b = Buffer.from(cfg.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4096) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}
const publicView = (i) => ({
  id: i.id,
  status: i.status,
  address: i.address,
  amount: fmt(i.amountAtomic),
  received: fmt(i.receivedAtomic || '0'),
  confirmations: i.confirmations,
  required: cfg.confirmations,
  expiresAt: i.expiresAt,
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'POST' && p === '/api/invoices') {
        if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
        const body = await readJson(req);
        const amountAtomic = toAtomic(body.amount);
        if (!amountAtomic) return send(res, 400, { error: `amount must be a positive number with up to ${decimals} decimals` });
        const id = crypto.randomBytes(16).toString('hex'); // unguessable: it is the only access key
        const { address, minor } = await rpc.createAddress('inv-' + id.slice(0, 8));
        const inv = {
          id, address, minor,
          amountAtomic: amountAtomic.toString(),
          orderRef: typeof body.orderRef === 'string' ? body.orderRef.slice(0, 64) : null,
          status: 'pending', confirmations: 0, receivedAtomic: '0',
          createdAt: Date.now(), expiresAt: Date.now() + cfg.ttlMs,
        };
        store.put(inv);
        return send(res, 201, { ...publicView(inv), payUrl: `/pay/${id}` });
      }
      let m;
      if (req.method === 'GET' && (m = /^\/api\/invoices\/([0-9a-f]{32})$/.exec(p))) {
        const inv = store.get(m[1]);
        return inv ? send(res, 200, publicView(inv)) : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && /^\/pay\/[0-9a-f]{32}$/.test(p))
        return send(res, 200, fs.readFileSync(path.join(pub, 'checkout.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/checkout.js')
        return send(res, 200, fs.readFileSync(path.join(pub, 'checkout.js')), 'text/javascript; charset=utf-8');
      // dev only: pretend the customer paid
      if (cfg.mock && req.method === 'POST' && (m = /^\/dev\/pay\/([0-9a-f]{32})$/.exec(p))) {
        const inv = store.get(m[1]);
        if (!inv) return send(res, 404, { error: 'not found' });
        rpc.simulate(inv.minor, inv.amountAtomic);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  })
  .listen(cfg.port, cfg.host, () =>
    console.log(`BDX Pay on http://${cfg.host}:${cfg.port} ${cfg.mock ? '(MOCK wallet)' : '(wallet: ' + cfg.rpcUrl + ')'}`),
  );
