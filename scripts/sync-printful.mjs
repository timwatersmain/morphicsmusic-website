/**
 * sync-printful.mjs
 *
 * Pulls full product + variant data from Printful and writes src/data/merch.json.
 * Each variant carries its own Printful variant_id, size, color, and retail price
 * — required so the Stripe checkout function and the webhook can map a paid
 * line item back to a fulfillable Printful variant.
 *
 * Requires PRINTFUL_API_KEY in env (or .env file).
 *
 * Usage: node scripts/sync-printful.mjs
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// Lightweight .env loader — avoids pulling a dep just for this.
const envPath = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TOKEN = process.env.PRINTFUL_API_KEY;
if (!TOKEN) {
  console.error('✗ PRINTFUL_API_KEY missing. Add it to website/.env or export it.');
  process.exit(1);
}

const SITE_PATH = resolve(import.meta.dirname, '..');
const API = 'https://api.printful.com';

async function pf(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()).result;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

console.log('• fetching Printful store products...');
const products = await pf('/store/products');
console.log(`  ${products.length} products`);

const out = [];
for (const p of products) {
  console.log(`• ${p.name}`);
  const detail = await pf(`/store/products/${p.id}`);
  const variants = detail.sync_variants.map(v => ({
    variant_id: v.id,                    // sync variant id (used in order create)
    catalog_variant_id: v.variant_id,    // printful catalog id
    name: v.name,
    size: v.size || null,
    color: v.color || null,
    retail_price: parseFloat(v.retail_price),
    currency: v.currency,
    sku: v.sku,
    available: v.availability_status === 'active',
    preview: v.files?.find(f => f.type === 'preview')?.preview_url || null,
  }));

  const sizes = [...new Set(variants.map(v => v.size).filter(Boolean))];
  const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
  const prices = variants.map(v => v.retail_price);

  out.push({
    id: p.id,
    slug: slugify(p.name),
    name: p.name,
    thumbnail: p.thumbnail_url,
    price_low: Math.min(...prices),
    price_high: Math.max(...prices),
    currency: variants[0]?.currency || 'USD',
    sizes,
    colors,
    variant_count: variants.length,
    variants,
  });
}

const path = join(SITE_PATH, 'src', 'data', 'merch.json');
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log(`✓ merch.json — ${out.length} products, ${out.reduce((n, p) => n + p.variants.length, 0)} variants`);
