import type { ImageDto, SwatchDto } from '@avero/shared';
import { ArrowLeft, ArrowRight, Heart, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../../lib/cx';
import { ArrowLink, ButtonLink } from './Button';
import { Badge, PriceTag, Rating } from './Commerce';
import styles from './Merch.module.css';
import { imageSrcSet } from '../../lib/images';

export type SurfaceTone = 'muted' | 'sand' | 'sage' | 'mist' | 'mauve' | 'white';

/* ---------- media ---------- */

interface ProductMediaProps {
  image?: ImageDto | null;
  alt?: string;
  ratio?: '1/1' | '4/5' | '3/4' | '16/9' | '5/2';
  tone?: SurfaceTone;
  priority?: boolean;
  /** Second image cross-faded in on hover (desktop). */
  hoverImage?: ImageDto | null;
  /** `sizes` attribute so the browser picks the 400w thumbnail where it is enough. */
  sizes?: string;
  /** Multiply-blend studio shots so their white backdrop takes the surface colour. */
  blend?: boolean;
  fit?: 'cover' | 'contain';
  className?: string;
  radius?: 'md' | 'lg' | 'xl' | 'arch' | 'none';
}


/**
 * Reserves its box via aspect-ratio (no layout shift), lazy-loads unless `priority`, and fades
 * in once decoded. Without an image it shows a soft placeholder.
 */
export function ProductMedia({
  image,
  alt,
  ratio = '1/1',
  tone = 'muted',
  priority,
  hoverImage,
  sizes = '(min-width: 1024px) 25vw, 50vw',
  blend,
  fit = 'cover',
  className,
  radius = 'lg',
}: ProductMediaProps) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={cx(
        styles.media,
        styles[`tone-${tone}`],
        styles[`radius-${radius}`],
        hoverImage && styles.hasHover,
        blend && styles.blend,
        fit === 'contain' && styles.contain,
        className,
      )}
      style={{ aspectRatio: ratio } as CSSProperties}
    >
      {image ? (
        <>
          <img
            src={image.url}
            srcSet={imageSrcSet(image)}
            sizes={sizes}
            alt={alt ?? image.alt}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
            onLoad={() => setLoaded(true)}
            ref={(el) => {
              // Cached images can finish before React attaches onLoad.
              if (el?.complete && el.naturalWidth > 0 && !loaded) setLoaded(true);
            }}
            className={cx(styles.img, loaded && styles.loaded)}
          />
          {hoverImage ? (
            <img src={hoverImage.url} srcSet={imageSrcSet(hoverImage)} sizes={sizes} alt="" loading="lazy" decoding="async" className={styles.hoverImg} />
          ) : null}
        </>
      ) : (
        <ShoePlaceholder label={alt ?? ''} />
      )}
    </div>
  );
}

function ShoePlaceholder({ label }: { label: string }) {
  return (
    <svg className={styles.placeholder} viewBox="0 0 200 110" role="img" aria-label={label}>
      <path d="M14 78c0-9 8-15 22-18l38-8c14-3 24-16 34-19 8-2 14 2 18 9 8 12 22 17 42 20 14 2 20 8 20 17v6c0 4-3 6-8 6H22c-5 0-8-3-8-7z" />
      <path d="M14 86h174" className={styles.sole} />
    </svg>
  );
}

/* ---------- product card ---------- */

export interface ProductCardData {
  href: string;
  name: string;
  colorName: string;
  image: ImageDto | null;
  hoverImage?: ImageDto | null;
  pricePaise: number;
  mrpPaise?: number;
  badge?: string | null;
  swatches?: SwatchDto[];
  rating?: { value: number; count: number } | null;
  inStock?: boolean;
}

interface ProductCardProps {
  product: ProductCardData;
  /** Slot for a wishlist toggle (see WishButton). */
  wishlistButton?: ReactNode;
  priority?: boolean;
  sizes?: string;
}

/** Heart toggle positioned in a product card's media corner. */
export function WishButton({ pressed, name, onClick, disabled }: { pressed: boolean; name: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={cx(styles.wish, pressed && styles.wishOn)}
      aria-label={pressed ? `Remove ${name} from wishlist` : `Add ${name} to wishlist`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Heart size={18} strokeWidth={1.6} aria-hidden />
    </button>
  );
}

export function ProductCard({ product: p, wishlistButton, priority, sizes }: ProductCardProps) {
  const soldOut = p.inStock === false;
  const swatches = p.swatches ?? [];
  return (
    <article className={styles.card}>
      <Link to={p.href} className={styles.cardLink}>
        <span className="visually-hidden">
          {p.name}, {p.colorName}
        </span>
      </Link>
      <div className={styles.cardMedia}>
        <ProductMedia
          image={p.image}
          hoverImage={p.hoverImage}
          alt={`${p.name} in ${p.colorName}`}
          tone="muted"
          radius="md"
          priority={priority}
          sizes={sizes}
        />
        {p.badge || soldOut ? (
          <div className={styles.cardBadge}>
            <Badge tone={soldOut ? 'danger' : 'neutral'}>{soldOut ? 'Sold out' : p.badge}</Badge>
          </div>
        ) : null}
        {wishlistButton}
      </div>
      <div className={styles.cardBody}>
        <h3 className={styles.cardName}>{p.name}</h3>
        <p className="meta">{p.colorName}</p>
        {swatches.length > 1 ? (
          <ul role="list" className={styles.cardSwatches} aria-label={`${swatches.length} colours`}>
            {swatches.slice(0, 4).map((s) => (
              <li key={s.colorwayId}>
                <Link to={s.href} className={styles.cardSwatch} style={{ background: s.hex }} title={s.name} aria-label={s.name} />
              </li>
            ))}
            {swatches.length > 4 ? <li className="meta">+{swatches.length - 4}</li> : null}
          </ul>
        ) : null}
        <div className={styles.cardFoot}>
          <PriceTag price={p.pricePaise} mrp={p.mrpPaise} />
          {p.rating && p.rating.count > 0 ? <Rating value={p.rating.value} /> : null}
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({ children, columns = 3 }: { children: ReactNode; columns?: 3 | 4 }) {
  return (
    <ul role="list" className={cx(styles.grid, styles[`grid-${columns}`])}>
      {children}
    </ul>
  );
}

/** Horizontally scrolling row of cards (recommendations, recently viewed). */
export function ProductRail({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={styles.rail} aria-label={title}>
      <div className={styles.railHead}>
        <h2>{title}</h2>
        {action}
      </div>
      <ul role="list" className={styles.railList}>
        {children}
      </ul>
    </section>
  );
}

/* ---------- collection tile ---------- */

interface CollectionTileProps {
  to: string;
  title: string;
  tone: SurfaceTone;
  image?: ImageDto | null;
  arch?: boolean;
  cta?: string;
}

export function CollectionTile({ to, title, tone, image, arch, cta = 'Shop now' }: CollectionTileProps) {
  return (
    <Link to={to} className={cx(styles.tile, styles[`tone-${tone}`], arch && styles.tileArch)}>
      <div className={styles.tileMedia}>
        {image ? (
          <img src={image.url} srcSet={imageSrcSet(image)} sizes="(min-width: 1024px) 25vw, 50vw" alt="" loading="lazy" decoding="async" />
        ) : (
          <ShoePlaceholder label="" />
        )}
      </div>
      <div className={styles.tileText}>
        <span className={styles.tileTitle}>{title}</span>
        <span className={styles.tileCta}>
          {cta} <ArrowRight size={14} aria-hidden />
        </span>
      </div>
    </Link>
  );
}

/* ---------- hero ---------- */

export interface HeroSlide {
  eyebrow: string;
  title: string;
  body?: string;
  image?: ImageDto | null;
  to?: string;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Hero carousel. Advances by itself every `interval` ms like a shop carousel; holds while the
 * pointer is over it, keyboard focus is inside it, or the tab is hidden. The active index's
 * underline fills as a progress bar — that CSS animation *is* the timer (`onAnimationEnd` moves
 * on), so the bar and the slide change always agree. Images stay mounted and crossfade with a slow
 * zoom; the text rises in with a short stagger. With reduced motion there is no autoplay.
 */
export function Hero({ slides, actions, interval = 4500 }: { slides: HeroSlide[]; actions: ReactNode; interval?: number }) {
  const [index, setIndex] = useState(0);
  const [autoplay] = useState(() => !prefersReducedMotion());
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  const count = slides.length;
  const slide = slides[index % count]!;
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  const playing = autoplay && count > 1;
  const running = playing && !held && !hidden;

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <section
      className={styles.hero}
      aria-roledescription="carousel"
      aria-label="Featured"
      style={{ '--hero-interval': `${interval}ms` } as CSSProperties}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <div className={styles.heroMedia}>
        {slides.map((s, i) =>
          s.image ? (
            <img
              key={s.image.url}
              src={s.image.url}
              alt={i === index ? s.image.alt : ''}
              aria-hidden={i !== index}
              fetchPriority={i === 0 ? 'high' : 'auto'}
              className={cx(styles.heroImg, i === index && styles.heroImgActive)}
            />
          ) : null,
        )}
        {!slide.image ? (
          <div className={styles.heroPlaceholder} aria-hidden>
            <ShoePlaceholder label="" />
          </div>
        ) : null}
      </div>
      {/* Automatic changes aren't announced; changes the shopper makes are. */}
      <div className={styles.heroContent} aria-live={playing ? 'off' : 'polite'}>
        <div key={index} className={styles.heroText}>
          <p className={cx('eyebrow', styles.heroRise)}>{slide.eyebrow}</p>
          <h1 className={cx(styles.heroTitle, styles.heroRise)}>{slide.title}</h1>
          {slide.body ? <p className={cx(styles.heroBody, styles.heroRise)}>{slide.body}</p> : null}
        </div>
        <div className={styles.heroActions}>{actions}</div>
        {slide.to ? (
          <Link to={slide.to} className={styles.heroLink}>
            Explore {slide.eyebrow.toLowerCase()} <ArrowRight size={14} aria-hidden />
          </Link>
        ) : null}
      </div>
      {count > 1 ? (
        <div className={styles.heroNav}>
          <button type="button" className={styles.heroArrow} onClick={() => go(-1)} aria-label="Previous slide">
            <ArrowLeft size={16} aria-hidden />
          </button>
          <ol role="list" className={cx(styles.heroIndex, playing && styles.heroIndexPlaying)}>
            {slides.map((s, i) => (
              <li key={s.title}>
                <button type="button" aria-label={`Slide ${i + 1} of ${count}`} aria-current={i === index} onClick={() => setIndex(i)}>
                  {String(i + 1).padStart(2, '0')}
                  {playing && i === index ? (
                    <span
                      key={index}
                      aria-hidden
                      className={styles.heroProgress}
                      style={{ animationPlayState: running ? 'running' : 'paused' }}
                      onAnimationEnd={() => go(1)}
                    />
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className={styles.heroArrow} onClick={() => go(1)} aria-label="Next slide">
            <ArrowRight size={16} aria-hidden />
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ---------- editorial ---------- */

export interface EditorialSlide {
  eyebrow?: string;
  title: string;
  body: string;
  cta: { to: string; label: string };
  image?: ImageDto | null;
  secondaryImage?: ImageDto | null;
}

/**
 * Editorial block that rotates through `slides` every `interval` ms, with the hero's motion (images
 * crossfade with a slow zoom, text rises in) but no arrows or index. All slides stay mounted and
 * share one grid cell, so the block keeps the height of its tallest slide and never jumps. Holds
 * while hovered, focused or the tab is hidden; with reduced motion it stays on the first slide.
 */
export function EditorialSection({ slides, reverse, interval = 4500 }: { slides: EditorialSlide[]; reverse?: boolean; interval?: number }) {
  const [index, setIndex] = useState(0);
  const [autoplay] = useState(() => !prefersReducedMotion());
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  const count = slides.length;
  const running = autoplay && count > 1 && !held && !hidden;

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % count), interval);
    return () => window.clearTimeout(t);
  }, [running, index, count, interval]);

  if (count === 0) return null;
  const layer = (i: number) => cx(styles.editorialLayer, i === index && styles.editorialLayerActive);

  return (
    <section
      className={cx(styles.editorial, reverse && styles.editorialReverse)}
      style={{ '--hero-interval': `${interval}ms` } as CSSProperties}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <div className={styles.editorialText}>
        <div className={styles.editorialStack}>
          {slides.map((s, i) => {
            const active = i === index;
            // Only the visible slide's text animates, so it rises in again each time it returns.
            const rise = active && autoplay ? styles.heroRise : undefined;
            return (
              <div key={s.title} className={cx(styles.editorialCopy, !active && styles.editorialCopyHidden)} inert={!active} aria-hidden={!active}>
                {s.eyebrow ? <p className={cx('eyebrow', rise)}>{s.eyebrow}</p> : null}
                <div className={cx(styles.editorialHead, rise)}>
                  <h2 className={styles.editorialTitle}>{s.title}</h2>
                  <ArrowLink to={s.cta.to} label={s.cta.label} />
                </div>
                <p className={cx(styles.editorialBody, rise)}>{s.body}</p>
                <div>
                  <ButtonLink to={s.cta.to} variant="secondary">
                    {s.cta.label}
                  </ButtonLink>
                </div>
              </div>
            );
          })}
        </div>
        <div className={cx(styles.editorialStack, styles.editorialSecondary, styles['radius-lg'])}>
          {slides.map((s, i) => (
            <div key={s.title} className={layer(i)} aria-hidden={i !== index}>
              <ProductMedia image={s.secondaryImage} alt="" ratio="4/5" tone="sand" sizes="320px" />
            </div>
          ))}
        </div>
      </div>
      <div className={cx(styles.editorialStack, styles['radius-xl'])}>
        {slides.map((s, i) => (
          <div key={s.title} className={layer(i)} aria-hidden={i !== index}>
            <ProductMedia
              image={s.image}
              alt={i === index ? undefined : ''}
              ratio="4/5"
              tone="mauve"
              radius="xl"
              sizes="(min-width: 1024px) 55vw, 100vw"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- trust row ---------- */

export function TrustRow({ items }: { items: { icon: LucideIcon; title: string; body: string }[] }) {
  return (
    <ul role="list" className={styles.trust}>
      {items.map(({ icon: Icon, title, body }) => (
        <li key={title}>
          <Icon size={22} strokeWidth={1.4} aria-hidden />
          <span>
            <strong>{title}</strong>
            <span className="meta">{body}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
