import { includedGst } from '@avero/shared';
import { asc, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { orderItems } from '../../db/schema';
import { escapeHtml, formatRupees } from '../../lib/email-templates';
import { AppError } from '../../lib/errors';
import type { OrderRow } from '../../lib/transitions';

/** Fictional seller details for the simulated GST invoice. */
const SELLER = {
  name: 'AVERO Footwear Private Limited (fictional)',
  address: 'AVERO Fulfilment Centre, 21 Hosur Road, Bengaluru, Karnataka 560068',
  gstin: '29AAVCA0000A1Z5',
  state: 'Karnataka',
};
const SHIPPING_GST_BPS = 1800;

const INVOICEABLE = ['CONFIRMED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

export function invoiceAvailable(order: OrderRow): boolean {
  return order.kind === 'sale' && order.paidPaise > 0 && INVOICEABLE.includes(order.status);
}

/**
 * Tax invoice as a printable HTML page. Prices are GST-inclusive, so each line's tax is extracted
 * from its paid total. Intra-state supply (delivery in the seller's state) splits CGST + SGST;
 * otherwise IGST. Cancelled lines are left out (they are refunded, not supplied).
 */
export async function renderInvoice(ctx: AppContext, order: OrderRow): Promise<string> {
  if (!invoiceAvailable(order)) throw new AppError('NOT_FOUND', 'An invoice isn’t available for this order');
  const items = (await ctx.db.query.orderItems.findMany({ where: eq(orderItems.orderId, order.id), orderBy: asc(orderItems.createdAt) })).filter(
    (i) => i.status !== 'CANCELLED',
  );
  const intra = order.address.state === SELLER.state;
  const lines = items.map((i) => {
    const gst = includedGst(i.totalPaise, i.gstRateBps);
    return { label: `${i.productName} — ${i.colorwayName}, UK ${i.sizeLabel}`, hsn: '6404', qty: i.qty, rate: i.gstRateBps, taxable: i.totalPaise - gst, gst, total: i.totalPaise };
  });
  if (order.shippingPaise > 0) {
    const gst = includedGst(order.shippingPaise, SHIPPING_GST_BPS);
    lines.push({ label: 'Shipping charges', hsn: '9965', qty: 1, rate: SHIPPING_GST_BPS, taxable: order.shippingPaise - gst, gst, total: order.shippingPaise });
  }
  const sum = (k: 'taxable' | 'gst' | 'total') => lines.reduce((s, l) => s + l[k], 0);
  const pct = (bps: number) => `${bps / 100}%`;
  const taxCells = (gst: number, rate: number) =>
    intra
      ? `<td>${pct(rate / 2)} · ${formatRupees(Math.floor(gst / 2))}</td><td>${pct(rate / 2)} · ${formatRupees(gst - Math.floor(gst / 2))}</td>`
      : `<td>${pct(rate)} · ${formatRupees(gst)}</td>`;
  const a = order.address;
  const date = order.placedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${escapeHtml(order.orderNumber)}</title>
<style>
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1a;max-width:860px;margin:32px auto;padding:0 16px;font-size:14px}
h1{font-size:20px;letter-spacing:.04em;margin:0}h2{font-size:16px;margin:24px 0 8px}
.top{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}.muted{color:#6b6860}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #e4e0d8;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#4a4843}td.n,th.n{text-align:right}
tfoot td{font-weight:600}.note{margin-top:24px;font-size:12px;color:#6b6860}
@media print{body{margin:0}.noprint{display:none}}
</style></head><body>
<div class="top"><div><h1>AVERO</h1><p class="muted">${escapeHtml(SELLER.name)}<br>${escapeHtml(SELLER.address)}<br>GSTIN ${SELLER.gstin}</p></div>
<div><strong>Tax invoice</strong><br>Invoice no. INV-${escapeHtml(order.orderNumber.slice(3))}<br>Order ${escapeHtml(order.orderNumber)}<br>Date ${date}</div></div>
<h2>Bill to / Ship to</h2>
<p>${escapeHtml(a.fullName)}<br>${escapeHtml([a.line1, a.line2, a.landmark].filter(Boolean).join(', '))}<br>${escapeHtml(a.city)}, ${escapeHtml(a.state)} ${escapeHtml(a.pincode)}<br>${escapeHtml(order.phone)} · ${escapeHtml(order.email)}<br><span class="muted">Place of supply: ${escapeHtml(a.state)}</span></p>
<table><thead><tr><th>Item</th><th>HSN/SAC</th><th class="n">Qty</th><th class="n">Taxable value</th>${intra ? '<th>CGST</th><th>SGST</th>' : '<th>IGST</th>'}<th class="n">Total</th></tr></thead><tbody>
${lines.map((l) => `<tr><td>${escapeHtml(l.label)}</td><td>${l.hsn}</td><td class="n">${l.qty}</td><td class="n">${formatRupees(l.taxable)}</td>${taxCells(l.gst, l.rate)}<td class="n">${formatRupees(l.total)}</td></tr>`).join('')}
</tbody><tfoot><tr><td colspan="3">Total</td><td class="n">${formatRupees(sum('taxable'))}</td>${intra ? `<td colspan="2">${formatRupees(sum('gst'))}</td>` : `<td>${formatRupees(sum('gst'))}</td>`}<td class="n">${formatRupees(sum('total'))}</td></tr></tfoot></table>
${order.discountPaise > 0 || order.pointsDiscountPaise > 0 ? `<p class="muted">Line totals are after discounts${order.couponCode ? ` (coupon ${escapeHtml(order.couponCode)})` : ''}${order.pointsRedeemed ? ` and ${order.pointsRedeemed} AVERO points` : ''}.</p>` : ''}
${order.refundedPaise > 0 ? `<p class="muted">Refunded so far: ${formatRupees(order.refundedPaise)}.</p>` : ''}
<p class="note">This is a simulated invoice for a fictional brand — no real goods or payments are involved.</p>
<p class="noprint"><button onclick="window.print()">Print or save as PDF</button></p>
</body></html>`;
}
