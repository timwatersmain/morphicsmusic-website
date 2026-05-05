// Client-side cart for the Morphics store.
// Persists to localStorage and exposes window.morphicsCart for product pages.

const STORAGE_KEY = 'morphics_cart_v1';

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('cart:updated', { detail: { items } }));
}

const cart = {
  items() {
    return load();
  },
  count() {
    return load().reduce((n, i) => n + i.qty, 0);
  },
  subtotal() {
    return load().reduce((n, i) => n + i.unit_amount * i.qty, 0);
  },
  add(item) {
    const items = load();
    const existing = items.find(i => i.sku === item.sku);
    if (existing) {
      existing.qty += item.qty || 1;
      // Buyer entered a higher price for a name-your-price item — keep the higher.
      if (item.unit_amount > existing.unit_amount) existing.unit_amount = item.unit_amount;
    } else {
      items.push({ qty: 1, ...item });
    }
    save(items);
  },
  remove(sku) {
    save(load().filter(i => i.sku !== sku));
  },
  setQty(sku, qty) {
    const items = load();
    const it = items.find(i => i.sku === sku);
    if (!it) return;
    if (qty <= 0) return this.remove(sku);
    it.qty = qty;
    save(items);
  },
  clear() {
    save([]);
  },
  open() {
    document.dispatchEvent(new CustomEvent('cart:open'));
  },
  async checkout() {
    const items = load();
    if (items.length === 0) return;
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      alert('Checkout failed: ' + (await res.text()));
      return;
    }
    const { url } = await res.json();
    window.location.href = url;
  },
};

window.morphicsCart = cart;
