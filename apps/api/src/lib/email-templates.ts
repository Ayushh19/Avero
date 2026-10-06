import type { EmailMessage } from './mailer';

// Plain, functional templates. Branded styling follows the design spec later.
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px">
<h1 style="font-size:20px;letter-spacing:.2em">AVERO</h1><h2 style="font-size:18px">${title}</h2>${bodyHtml}
<p style="color:#888;font-size:12px;margin-top:32px">You received this email because of activity on your AVERO account.</p>
</body></html>`;
}

export function verifyEmailTemplate(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    template: 'verify_email',
    subject: 'Verify your email for AVERO',
    text: `Hi ${name}, confirm your email address: ${link}`,
    html: layout(
      'Confirm your email',
      `<p>Hi ${escapeHtml(name)},</p><p>Confirm your email address to secure your account.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 48 hours.</p>`,
    ),
  };
}

export function resetPasswordTemplate(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    template: 'reset_password',
    subject: 'Reset your AVERO password',
    text: `Hi ${name}, reset your password: ${link} (expires in 30 minutes). If you didn't request this, ignore this email.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${escapeHtml(name)},</p><p><a href="${link}">Choose a new password</a></p><p>This link expires in 30 minutes. If you didn't request a reset, you can ignore this email.</p>`,
    ),
  };
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export interface OrderEmailLine {
  productName: string;
  colorwayName: string;
  sizeLabel: string;
  qty: number;
  totalPaise: number;
}

const inr = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);

function linesHtml(lines: OrderEmailLine[]): string {
  return `<ul>${lines
    .map((l) => `<li>${escapeHtml(l.productName)} — ${escapeHtml(l.colorwayName)}, UK ${escapeHtml(l.sizeLabel)} × ${l.qty} · ${inr(l.totalPaise)}</li>`)
    .join('')}</ul>`;
}

export function orderConfirmedTemplate(
  to: string,
  order: { orderNumber: string; totalPaise: number; expectedDeliveryAt: Date | null; pointsEarned: number },
  lines: OrderEmailLine[],
  link: string,
): EmailMessage {
  const eta = order.expectedDeliveryAt
    ? `Expected by ${order.expectedDeliveryAt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}.`
    : '';
  const points = order.pointsEarned > 0 ? ` You’ll earn ${order.pointsEarned} points once the return window closes.` : '';
  return {
    to,
    template: 'order_confirmed',
    subject: `Order ${order.orderNumber} confirmed`,
    text: `Thanks for your order ${order.orderNumber}. Total paid ${inr(order.totalPaise)}. ${eta}${points} View it: ${link}`,
    html: layout(
      `Order ${escapeHtml(order.orderNumber)} confirmed`,
      `<p>Thanks — we’ve received your payment of ${inr(order.totalPaise)}. ${eta}${points}</p>${linesHtml(lines)}<p><a href="${link}">View your order</a></p>`,
    ),
  };
}

export function orderUnfulfillableTemplate(
  to: string,
  order: { orderNumber: string; paidPaise: number },
  link: string,
): EmailMessage {
  return {
    to,
    template: 'order_unfulfillable',
    subject: `We’re sorry — order ${order.orderNumber} couldn’t be completed`,
    text: `Your payment for ${order.orderNumber} arrived after your reservation ended and the items sold out. We’ve started a full refund of ${inr(order.paidPaise)}. ${link}`,
    html: layout(
      'We’re sorry',
      `<p>Your payment for order ${escapeHtml(order.orderNumber)} reached us after your 15-minute reservation ended, and the items have since sold out.</p><p>We’ve started a full refund of ${inr(order.paidPaise)} to your original payment method.</p><p><a href="${link}">View your order</a></p>`,
    ),
  };
}

/** Plain notification email: a heading, a few short paragraphs and one link. */
export function noticeTemplate(input: {
  to: string;
  template: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  link?: { href: string; label: string };
}): EmailMessage {
  const linkText = input.link ? ` ${input.link.label}: ${input.link.href}` : '';
  return {
    to: input.to,
    template: input.template,
    subject: input.subject,
    text: `${input.paragraphs.join(' ')}${linkText}`,
    html: layout(
      escapeHtml(input.heading),
      `${input.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}${input.link ? `<p><a href="${input.link.href}">${escapeHtml(input.link.label)}</a></p>` : ''}`,
    ),
  };
}

export const formatRupees = inr;
