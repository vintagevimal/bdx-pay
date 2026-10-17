// Thin client for beldex-wallet-rpc (Monero-lineage JSON-RPC).
// Method names below follow the Monero-style API; verify against
// `beldex-wallet-rpc --help` / the Beldex docs for your daemon version.
// All wallet-specific code lives in this file so it is the only thing to adjust.

export class WalletRpc {
  constructor(url) {
    this.url = url.replace(/\/$/, '') + '/json_rpc';
  }

  async call(method, params = {}) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`wallet rpc HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`wallet rpc ${method}: ${json.error.message}`);
    return json.result;
  }

  // One fresh subaddress per invoice: payments to different invoices
  // can't be linked to each other on-chain.
  async createAddress(label) {
    const r = await this.call('create_address', { account_index: 0, label });
    return { address: r.address, minor: r.address_index };
  }

  // Incoming transfers (confirmed + mempool) for the given subaddress indices.
  async getTransfers(minors) {
    return this.call('get_transfers', {
      in: true,
      pool: true,
      account_index: 0,
      subaddr_indices: minors,
    });
  }
}

// In-memory fake wallet so you can demo the whole flow without a node.
export class MockRpc {
  constructor() {
    this.next = 1;
    this.payments = []; // {minor, amount, confirmations, txid}
  }
  async createAddress() {
    const minor = this.next++;
    return { address: `Bmock${String(minor).padStart(4, '0')}x`.padEnd(40, 'q'), minor };
  }
  async getTransfers(minors) {
    // every poll, mock payments gain one confirmation
    this.payments.forEach((p) => (p.confirmations += 1));
    const mine = this.payments
      .filter((p) => minors.includes(p.subaddr_index.minor))
      .map((p) => ({ ...p }));
    return { in: mine.filter((p) => p.confirmations > 0), pool: mine.filter((p) => p.confirmations === 0) };
  }
  simulate(minor, amountAtomic) {
    this.payments.push({
      amount: String(amountAtomic),
      confirmations: 0,
      txid: 'mock' + Math.random().toString(16).slice(2),
      subaddr_index: { major: 0, minor },
    });
  }
}
