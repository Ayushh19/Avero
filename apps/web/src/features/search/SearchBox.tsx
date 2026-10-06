import { formatINR, searchParamsFor } from '@avero/shared';
import { ArrowUpRight, Clock, Search, TrendingUp, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSuggest, useTrending } from '../../lib/catalog';
import { cx } from '../../lib/cx';
import { recentSearches, rememberSearch } from '../../lib/storage';
import styles from './SearchBox.module.css';

interface Option {
  id: string;
  kind: 'query' | 'recent' | 'trending' | 'product' | 'category' | 'collection';
  label: string;
  meta?: string;
  to: string;
  image?: string | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Recognised terms become explicit filters (see searchParamsFor). */
export const searchHref = (q: string) => `/search?${searchParamsFor(q)}`;

/** WAI-ARIA combobox: the input keeps focus, options are navigated with arrow keys. */
export function SearchBox({ autoFocus, onNavigate }: { autoFocus?: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const listId = useId();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(value, 180);
  const suggest = useSuggest(debounced);
  const trending = useTrending();
  const recent = recentSearches.useValue();
  const typing = value.trim().length >= 2;

  const groups = useMemo(() => {
    if (!typing) {
      return [
        { title: 'Recent searches', options: recent.map<Option>((q) => ({ id: `r-${q}`, kind: 'recent', label: q, to: searchHref(q) })) },
        { title: 'Popular right now', options: (trending.data ?? []).map<Option>((q) => ({ id: `t-${q}`, kind: 'trending', label: q, to: searchHref(q) })) },
      ].filter((g) => g.options.length);
    }
    const d = suggest.data;
    if (!d) return [];
    return [
      { title: 'Suggestions', options: d.queries.map<Option>((q) => ({ id: `q-${q}`, kind: 'query', label: q, to: searchHref(q) })) },
      {
        title: 'Products',
        options: d.products.map<Option>((p) => ({
          id: `p-${p.href}`,
          kind: 'product',
          label: p.name,
          meta: `${p.colorName} · ${formatINR(p.pricePaise)}`,
          to: p.href,
          image: p.image?.thumbUrl ?? p.image?.url,
        })),
      },
      { title: 'Categories', options: d.categories.map<Option>((c) => ({ id: `c-${c.to}`, kind: 'category', label: c.label, to: c.to })) },
      { title: 'Collections', options: d.collections.map<Option>((c) => ({ id: `k-${c.to}`, kind: 'collection', label: c.label, to: c.to })) },
    ].filter((g) => g.options.length);
  }, [typing, recent, trending.data, suggest.data]);

  const flat = groups.flatMap((g) => g.options);
  const showPanel = open && (flat.length > 0 || (typing && !suggest.isFetching && suggest.data !== undefined));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const go = (to: string, query?: string) => {
    if (query) rememberSearch(query);
    setOpen(false);
    setActive(-1);
    navigate(to);
    onNavigate?.();
  };

  const submit = () => {
    const option = flat[active];
    if (option) return go(option.to, option.kind === 'product' || option.kind === 'category' || option.kind === 'collection' ? undefined : option.label);
    const q = value.trim();
    if (q) go(searchHref(q), q);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (flat.length ? (i + 1) % flat.length : -1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i <= 0 ? flat.length - 1 : i - 1) : -1));
    } else if (e.key === 'Escape') {
      if (open) setOpen(false);
      else setValue('');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const activeId = active >= 0 ? `${listId}-${active}` : undefined;
  let index = -1;

  return (
    <div className={styles.root} ref={rootRef}>
      <form
        role="search"
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Search size={16} aria-hidden className={styles.icon} />
        <input
          type="search"
          role="combobox"
          aria-label="Search shoes and collections"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder="Search shoes, collections…"
          autoComplete="off"
          enterKeyHint="search"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={styles.input}
        />
        {value ? (
          <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => setValue('')}>
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </form>

      {showPanel ? (
        <div className={styles.panel}>
          <ul role="listbox" id={listId} aria-label="Search suggestions" className={styles.list}>
            {groups.map((g) => (
              <li key={g.title} role="presentation">
                <p className={styles.groupTitle}>
                  {g.title}
                  {g.title === 'Recent searches' ? (
                    <button type="button" className={styles.clearRecent} onClick={() => recentSearches.set([])}>
                      Clear
                    </button>
                  ) : null}
                </p>
                <ul role="presentation" className={cx(g.title === 'Products' && styles.products)}>
                  {g.options.map((o) => {
                    index++;
                    const i = index;
                    return (
                      <li
                        key={o.id}
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={cx(styles.option, i === active && styles.active)}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => go(o.to, o.kind === 'product' || o.kind === 'category' || o.kind === 'collection' ? undefined : o.label)}
                        onPointerMove={() => setActive(i)}
                      >
                        {o.kind === 'product' ? (
                          <img src={o.image ?? undefined} alt="" className={styles.thumb} loading="lazy" />
                        ) : o.kind === 'recent' ? (
                          <Clock size={15} aria-hidden className={styles.optionIcon} />
                        ) : o.kind === 'trending' ? (
                          <TrendingUp size={15} aria-hidden className={styles.optionIcon} />
                        ) : o.kind === 'query' ? (
                          <Search size={15} aria-hidden className={styles.optionIcon} />
                        ) : (
                          <ArrowUpRight size={15} aria-hidden className={styles.optionIcon} />
                        )}
                        <span className={styles.optionText}>
                          <span>{o.label}</span>
                          {o.meta ? <span className="meta">{o.meta}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          {typing ? (
            flat.length === 0 ? (
              <p className={styles.empty}>No matches for “{value.trim()}”. Try a colour, style or size — like “white sneakers” or “size 9”.</p>
            ) : (
              <button type="button" className={styles.seeAll} onPointerDown={(e) => e.preventDefault()} onClick={() => go(searchHref(value.trim()), value.trim())}>
                See all results for “{value.trim()}”
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
