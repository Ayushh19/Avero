import { formatINR } from '@avero/shared';
import { Minus, Plus, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Commerce.module.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cx(styles.badge, styles[`badge-${tone}`], className)}>{children}</span>;
}

/* ---------- swatches ---------- */

export interface SwatchOption {
  id: string;
  name: string;
  hex: string;
  available?: boolean;
}

interface SwatchGroupProps {
  label: string;
  options: SwatchOption[];
  value?: string;
  onChange?: (id: string) => void;
  /** Display-only small swatches with "+N" overflow (product cards). */
  compact?: boolean;
  max?: number;
}

export function SwatchGroup({ label, options, value, onChange, compact, max }: SwatchGroupProps) {
  const shown = max ? options.slice(0, max) : options;
  const overflow = options.length - shown.length;

  if (compact || !onChange) {
    return (
      <div className={cx(styles.swatches, compact && styles.swatchesCompact)} aria-label={label} role="img">
        {shown.map((o) => (
          <span key={o.id} className={styles.swatch} style={{ background: o.hex }} title={o.name} />
        ))}
        {overflow > 0 ? <span className={styles.overflow}>+{overflow}</span> : null}
      </div>
    );
  }

  return (
    <div className={styles.swatches} role="radiogroup" aria-label={label}>
      {shown.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          aria-label={`${o.name}${o.available === false ? ' (sold out)' : ''}`}
          title={o.name}
          onClick={() => onChange(o.id)}
          className={cx(styles.swatch, styles.swatchButton, o.available === false && styles.soldOut)}
          style={{ background: o.hex }}
        />
      ))}
    </div>
  );
}

/* ---------- sizes ---------- */

export interface SizeOption {
  id: string;
  label: string;
  state: 'available' | 'low' | 'unavailable';
}

interface SizeSelectorProps {
  label: string;
  options: SizeOption[];
  value?: string;
  onChange: (id: string) => void;
}

/** Unavailable sizes stay focusable/selectable so the PDP can offer "Notify me". */
export function SizeSelector({ label, options, value, onChange }: SizeSelectorProps) {
  return (
    <div className={styles.sizes} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          aria-label={`Size ${o.label}${o.state === 'unavailable' ? ', sold out' : o.state === 'low' ? ', low stock' : ''}`}
          onClick={() => onChange(o.id)}
          className={cx(styles.size, styles[`size-${o.state}`])}
        >
          {o.label}
          {o.state === 'low' ? <span className={styles.lowDot} aria-hidden /> : null}
        </button>
      ))}
    </div>
  );
}

/* ---------- quantity ---------- */

interface QuantityStepperProps {
  value: number;
  min?: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  label?: string;
}

export function QuantityStepper({ value, min = 1, max, onChange, disabled, label = 'Quantity' }: QuantityStepperProps) {
  return (
    <div className={styles.stepper} role="group" aria-label={label}>
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={14} aria-hidden />
      </button>
      <output aria-live="polite" className="tabular">
        {value}
      </output>
      <button
        type="button"
        aria-label="Increase quantity"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={14} aria-hidden />
      </button>
    </div>
  );
}

/* ---------- rating ---------- */

export function Rating({ value, count, size = 'sm', showValue = true }: { value: number; count?: number; size?: 'sm' | 'md'; showValue?: boolean }) {
  const rounded = Math.round(value * 2) / 2;
  const px = size === 'md' ? 16 : 13;
  return (
    <span className={cx(styles.rating, styles[`rating-${size}`])}>
      <span className={styles.stars} aria-hidden>
        {[1, 2, 3, 4, 5].map((i) =>
          i - 0.5 === rounded ? (
            <span key={i} className={styles.half}>
              <Star size={px} className={styles.starOff} />
              <Star size={px} className={cx(styles.starOn, styles.halfOn)} />
            </span>
          ) : (
            <Star key={i} size={px} className={i <= rounded ? styles.starOn : styles.starOff} />
          ),
        )}
      </span>
      <span className="visually-hidden">Rated {value.toFixed(1)} out of 5</span>
      {showValue ? (
        <span aria-hidden className={styles.ratingValue}>
          {value.toFixed(1)}
        </span>
      ) : null}
      {count !== undefined ? <span className={styles.ratingCount}>({count.toLocaleString('en-IN')} reviews)</span> : null}
    </span>
  );
}

/* ---------- star input ---------- */

const STAR_WORDS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];

/** 1–5 star picker built on native radios: arrow keys move, labels say "4 stars, Very good". */
export function StarInput({ value, onChange, name = 'rating', error }: { value: number; onChange: (v: number) => void; name?: string; error?: string }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <fieldset className={styles.starInput} aria-invalid={error ? true : undefined}>
      <legend className={styles.starLegend}>Your rating</legend>
      <div className={styles.starRow} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={styles.starOption} onMouseEnter={() => setHover(n)}>
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} className="visually-hidden" />
            <Star size={28} strokeWidth={1.5} className={n <= shown ? styles.starOn : styles.starOff} aria-hidden />
            <span className="visually-hidden">
              {n} {n === 1 ? 'star' : 'stars'}, {STAR_WORDS[n]}
            </span>
          </label>
        ))}
        <span className={styles.starWord} aria-hidden>
          {STAR_WORDS[shown] ?? ''}
        </span>
      </div>
      {error ? (
        <p className={styles.starError} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/* ---------- price ---------- */

export function PriceTag({ price, mrp, size = 'md' }: { price: number; mrp?: number; size?: 'md' | 'lg' }) {
  const discounted = mrp !== undefined && mrp > price;
  const pct = discounted ? Math.round(((mrp - price) / mrp) * 100) : 0;
  return (
    <span className={cx(styles.price, styles[`price-${size}`])}>
      <span className={styles.priceNow}>{formatINR(price)}</span>
      {discounted ? (
        <>
          <s className={styles.mrp}>
            <span className="visually-hidden">MRP </span>
            {formatINR(mrp)}
          </s>
          <span className={styles.off}>{pct}% off</span>
        </>
      ) : null}
    </span>
  );
}

/* ---------- stock ---------- */

export function StockIndicator({ state, left, note }: { state: 'in' | 'low' | 'out'; left?: number; note?: ReactNode }) {
  const text = state === 'in' ? 'In stock' : state === 'low' ? `Only ${left ?? 'a few'} left` : 'Out of stock';
  return (
    <p className={cx(styles.stock, styles[`stock-${state}`])}>
      <span className={styles.stockDot} aria-hidden />
      <span>{text}</span>
      {note ? <span className={styles.stockNote}>· {note}</span> : null}
    </p>
  );
}
