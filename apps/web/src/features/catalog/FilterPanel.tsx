import { formatINR, type ListingFacets } from '@avero/shared';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { Checkbox } from '../../components/ui/Form';
import { Accordion } from '../../components/ui/Nav';
import { cx } from '../../lib/cx';
import styles from './FilterPanel.module.css';

export type FilterUpdate = Record<string, string | null>;

export const FILTER_KEYS = ['gender', 'activity', 'size', 'color', 'priceMin', 'priceMax', 'onSale', 'inStock'] as const;

const list = (params: URLSearchParams, key: string) => (params.get(key) ?? '').split(',').filter(Boolean);

function toggle(params: URLSearchParams, key: string, value: string): FilterUpdate {
  const current = list(params, key);
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { [key]: next.length ? next.join(',') : null };
}

interface FilterPanelProps {
  facets: ListingFacets;
  params: URLSearchParams;
  onChange: (update: FilterUpdate) => void;
  /** Hide dimensions already fixed by the page (e.g. gender on /c/men). */
  hide?: ('gender' | 'activity')[];
}

export function FilterPanel({ facets, params, onChange, hide = [] }: FilterPanelProps) {
  const selected = (key: string) => list(params, key);
  const showGender = !hide.includes('gender') && (facets.gender.length > 1 || selected('gender').length > 0);
  const showActivity = !hide.includes('activity') && (facets.activity.length > 1 || selected('activity').length > 0);

  return (
    <div className={styles.panel}>
      {showGender ? (
        <Accordion title="Gender" defaultOpen meta={selected('gender').length ? `${selected('gender').length} selected` : undefined}>
          <div className={styles.checks}>
            {facets.gender.map((f) => (
              <Checkbox
                key={f.value}
                label={
                  <span className={styles.checkLabel}>
                    {f.label} <span className="meta">({f.count})</span>
                  </span>
                }
                checked={selected('gender').includes(f.value)}
                disabled={f.count === 0 && !selected('gender').includes(f.value)}
                onChange={() => onChange(toggle(params, 'gender', f.value))}
              />
            ))}
          </div>
        </Accordion>
      ) : null}

      {showActivity ? (
        <Accordion title="Category" defaultOpen meta={selected('activity').length ? `${selected('activity').length} selected` : undefined}>
          <div className={styles.checks}>
            {facets.activity.map((f) => (
              <Checkbox
                key={f.value}
                label={
                  <span className={styles.checkLabel}>
                    {f.label} <span className="meta">({f.count})</span>
                  </span>
                }
                checked={selected('activity').includes(f.value)}
                disabled={f.count === 0 && !selected('activity').includes(f.value)}
                onChange={() => onChange(toggle(params, 'activity', f.value))}
              />
            ))}
          </div>
        </Accordion>
      ) : null}

      {facets.size.length ? (
        <Accordion title="Size (UK/IND)" defaultOpen meta={selected('size').length ? `${selected('size').length} selected` : undefined}>
          <div className={styles.sizes} role="group" aria-label="Filter by size">
            {facets.size.map((f) => {
              const on = selected('size').includes(f.value);
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={on}
                  disabled={f.count === 0 && !on}
                  className={cx(styles.size, on && styles.sizeOn)}
                  onClick={() => onChange(toggle(params, 'size', f.value))}
                  title={f.count === 0 ? 'Not available in current results' : `${f.count} in stock`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </Accordion>
      ) : null}

      {facets.color.length ? (
        <Accordion title="Colour" defaultOpen meta={selected('color').length ? `${selected('color').length} selected` : undefined}>
          <div className={styles.colors} role="group" aria-label="Filter by colour">
            {facets.color.map((f) => {
              const on = selected('color').includes(f.value);
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={on}
                  disabled={f.count === 0 && !on}
                  className={cx(styles.color, on && styles.colorOn)}
                  onClick={() => onChange(toggle(params, 'color', f.value))}
                >
                  <span className={styles.dot} style={{ background: f.hex ?? '#ccc' }}>
                    {on ? <Check size={12} strokeWidth={3} aria-hidden /> : null}
                  </span>
                  <span>
                    {f.label} <span className="meta">({f.count})</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Accordion>
      ) : null}

      {facets.price ? (
        <Accordion title="Price" defaultOpen>
          <PriceRange
            bounds={facets.price}
            min={params.get('priceMin') ? Number(params.get('priceMin')) : undefined}
            max={params.get('priceMax') ? Number(params.get('priceMax')) : undefined}
            onCommit={(min, max) =>
              onChange({
                priceMin: min > facets.price!.min ? String(min) : null,
                priceMax: max < facets.price!.max ? String(max) : null,
              })
            }
          />
        </Accordion>
      ) : null}

      <Accordion title="Availability" defaultOpen>
        <div className={styles.checks}>
          <Checkbox
            label={
              <span className={styles.checkLabel}>
                In stock <span className="meta">({facets.inStock})</span>
              </span>
            }
            checked={params.get('inStock') === 'true'}
            onChange={(e) => onChange({ inStock: e.target.checked ? 'true' : null })}
          />
          <Checkbox
            label={
              <span className={styles.checkLabel}>
                On sale <span className="meta">({facets.onSale})</span>
              </span>
            }
            checked={params.get('onSale') === 'true'}
            disabled={facets.onSale === 0 && params.get('onSale') !== 'true'}
            onChange={(e) => onChange({ onSale: e.target.checked ? 'true' : null })}
          />
        </div>
      </Accordion>
    </div>
  );
}

function PriceRange({
  bounds,
  min,
  max,
  onCommit,
}: {
  bounds: { min: number; max: number };
  min?: number;
  max?: number;
  onCommit: (min: number, max: number) => void;
}) {
  const lo = Math.max(bounds.min, Math.min(min ?? bounds.min, bounds.max));
  const hi = Math.min(bounds.max, Math.max(max ?? bounds.max, bounds.min));
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const [a, b] = draft ?? [lo, hi];
  const span = Math.max(bounds.max - bounds.min, 1);
  const step = span > 2000 ? 100 : 50;
  const commit = () => {
    if (draft) onCommit(draft[0], draft[1]);
    setDraft(null);
  };

  if (bounds.max <= bounds.min) {
    return <p className="meta">All products are {formatINR(bounds.min * 100)}</p>;
  }

  return (
    <div className={styles.price}>
      <div className={styles.track}>
        <span className={styles.fill} style={{ left: `${((a - bounds.min) / span) * 100}%`, right: `${100 - ((b - bounds.min) / span) * 100}%` }} />
        <input
          type="range"
          aria-label="Minimum price"
          aria-valuetext={formatINR(a * 100)}
          min={bounds.min}
          max={bounds.max}
          step={step}
          value={a}
          onChange={(e) => setDraft([Math.min(Number(e.target.value), b - step), b])}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <input
          type="range"
          aria-label="Maximum price"
          aria-valuetext={formatINR(b * 100)}
          min={bounds.min}
          max={bounds.max}
          step={step}
          value={b}
          onChange={(e) => setDraft([a, Math.max(Number(e.target.value), a + step)])}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </div>
      <div className={styles.priceValues}>
        <span>{formatINR(a * 100)}</span>
        <span>{formatINR(b * 100)}</span>
      </div>
    </div>
  );
}

export interface ActiveFilter {
  key: string;
  label: string;
  update: FilterUpdate;
}

export function ActiveFilters({ filters, onChange, onClear }: { filters: ActiveFilter[]; onChange: (u: FilterUpdate) => void; onClear: () => void }) {
  if (filters.length === 0) return null;
  return (
    <div className={styles.chips} aria-label="Active filters">
      {filters.map((f) => (
        <button key={f.key} type="button" className={styles.chip} onClick={() => onChange(f.update)} aria-label={`Remove filter ${f.label}`}>
          {f.label}
          <X size={14} aria-hidden />
        </button>
      ))}
      <button type="button" className={styles.clearAll} onClick={onClear}>
        Clear all
      </button>
    </div>
  );
}
