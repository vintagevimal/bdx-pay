import fs from 'node:fs';
import path from 'node:path';

// Tiny file-backed store. Privacy by design: finished invoices are deleted
// after RETENTION_HOURS, and invoices never contain customer data.
export class Store {
  constructor(file) {
    this.file = file;
    this.invoices = {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.invoices = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.invoices), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  put(inv) {
    this.invoices[inv.id] = inv;
    this.save();
  }
  get(id) {
    return this.invoices[id];
  }
  open() {
    return Object.values(this.invoices).filter((i) => i.status === 'pending' || i.status === 'detected');
  }
  purge(maxAgeMs) {
    const now = Date.now();
    let n = 0;
    for (const [id, i] of Object.entries(this.invoices)) {
      if (i.closedAt && now - i.closedAt > maxAgeMs) {
        delete this.invoices[id];
        n++;
      }
    }
    if (n) this.save();
    return n;
  }
}
