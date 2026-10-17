const id = location.pathname.split('/').pop();
const $ = (s) => document.getElementById(s);
let timer;

function render(inv) {
  $('amount').textContent = inv.amount;
  $('addr').textContent = inv.address;
  const bar = $('bar');
  if (!bar.children.length) for (let i = 0; i < inv.required; i++) bar.appendChild(document.createElement('i'));
  [...bar.children].forEach((el, i) => el.classList.toggle('on', i < inv.confirmations || inv.status === 'confirmed'));
  const app = $('app');
  app.className = inv.status === 'confirmed' ? 'done' : inv.status === 'expired' ? 'failed' : '';
  const s = $('status');
  const meta = $('meta');
  if (inv.status === 'pending') {
    s.textContent = 'Waiting for payment';
    const mins = Math.max(0, Math.round((inv.expiresAt - Date.now()) / 60000));
    meta.textContent = `Send exactly ${inv.amount} BDX. This invoice expires in about ${mins} min.`;
    if (Number(inv.received) > 0) meta.textContent = `Received ${inv.received} of ${inv.amount} BDX. Send the remainder to the same address.`;
  } else if (inv.status === 'detected') {
    s.textContent = 'Payment seen, confirming';
    meta.textContent = `${inv.confirmations} of ${inv.required} confirmations. You can close this page; the merchant is notified automatically.`;
  } else if (inv.status === 'confirmed') {
    s.textContent = 'Payment confirmed';
    meta.textContent = 'Thank you. You can close this page.';
    clearInterval(timer);
  } else {
    s.textContent = 'Invoice expired';
    meta.textContent = 'Do not send funds to this address. Ask the merchant for a new invoice.';
    clearInterval(timer);
  }
}

async function poll() {
  try {
    const r = await fetch('/api/invoices/' + id, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    render(await r.json());
  } catch {
    $('status').textContent = 'Invoice not found';
    $('addr').textContent = 'Check the link you were given.';
    clearInterval(timer);
  }
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('addr').textContent);
    $('copy').textContent = 'Copied';
    setTimeout(() => ($('copy').textContent = 'Copy address'), 1500);
  } catch {}
});

poll();
timer = setInterval(poll, 5000);
