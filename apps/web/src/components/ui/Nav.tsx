import { Check, ChevronDown } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../../lib/cx';
import styles from './Nav.module.css';

/* ---------- tabs (WAI-ARIA tabs pattern, roving focus) ---------- */

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

export function Tabs({
  items,
  label,
  defaultId,
  activeId,
  onChange,
}: {
  items: TabItem[];
  label: string;
  defaultId?: string;
  /** Controlled mode (e.g. a "see reviews" link elsewhere on the page opens a tab). */
  activeId?: string;
  onChange?: (id: string) => void;
}) {
  const [own, setOwn] = useState(defaultId ?? items[0]?.id);
  const active = activeId ?? own;
  const setActive = (id: string) => {
    setOwn(id);
    onChange?.(id);
  };
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(items[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={label} className={styles.tabList}>
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            className={styles.tab}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={active !== t.id}
          tabIndex={0}
          className={styles.tabPanel}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}

/* ---------- accordion (native details/summary) ---------- */

export function Accordion({ title, children, defaultOpen, meta }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; meta?: ReactNode }) {
  return (
    <details className={styles.accordion} open={defaultOpen}>
      <summary className={styles.summary}>
        <span className={styles.summaryTitle}>{title}</span>
        {meta ? <span className="meta">{meta}</span> : null}
        <ChevronDown size={18} className={styles.chevron} aria-hidden />
      </summary>
      <div className={styles.accordionBody}>{children}</div>
    </details>
  );
}

/* ---------- breadcrumbs ---------- */

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.crumbs}>
      <ol role="list">
        {items.map((item, i) => (
          <li key={item.label}>
            {item.to && i < items.length - 1 ? (
              <Link to={item.to}>{item.label}</Link>
            ) : (
              <span aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* ---------- checkout stepper ---------- */

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol role="list" className={styles.stepper} aria-label="Checkout progress">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li key={label} className={cx(styles.step, styles[`step-${state}`])} aria-current={state === 'current' ? 'step' : undefined}>
            <span className={styles.stepDot}>{state === 'done' ? <Check size={12} strokeWidth={3} aria-hidden /> : null}</span>
            <span className={styles.stepLabel}>
              {label}
              {state === 'done' ? <span className="visually-hidden"> (completed)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- order timeline ---------- */

export interface TimelineStep {
  label: string;
  at?: string;
  state: 'done' | 'current' | 'upcoming';
}

export function OrderTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol role="list" className={styles.timeline} aria-label="Order progress">
      {steps.map((s) => (
        <li key={s.label} className={cx(styles.tlStep, styles[`tl-${s.state}`])} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className={styles.tlDot}>{s.state !== 'upcoming' ? <Check size={12} strokeWidth={3} aria-hidden /> : null}</span>
          <span className={styles.tlText}>
            <span className={styles.tlLabel}>{s.label}</span>
            {s.at ? <span className={styles.tlAt}>{s.at}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
