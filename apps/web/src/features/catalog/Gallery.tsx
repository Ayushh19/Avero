import type { ImageDto } from '@avero/shared';
import { ChevronLeft, ChevronRight, Expand } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from '../../components/ui/Overlay';
import { cx } from '../../lib/cx';
import styles from './Gallery.module.css';

/**
 * Desktop: vertical thumbnails + large image. Mobile: swipeable scroll-snap strip.
 * Any image opens a full-screen viewer with click-to-zoom.
 */
export function Gallery({ images, name, badge }: { images: ImageDto[]; name: string; badge?: string | null }) {
  const [index, setIndex] = useState(0);
  const [viewer, setViewer] = useState(false);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const current = images[index] ?? images[0];

  const go = (i: number) => {
    const next = (i + images.length) % images.length;
    setIndex(next);
    setZoom(null);
    const strip = stripRef.current;
    strip?.scrollTo({ left: next * strip.clientWidth, behavior: 'smooth' });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(index + 1);
    if (e.key === 'ArrowLeft') go(index - 1);
  };

  if (!current) return <div className={styles.empty} aria-hidden />;

  return (
    <div className={styles.gallery} onKeyDown={onKey}>
      <ul role="list" className={styles.thumbs} aria-label="Product images">
        {images.map((img, i) => (
          <li key={img.url}>
            <button type="button" className={cx(styles.thumb, i === index && styles.thumbOn)} onClick={() => go(i)} aria-label={`Show image ${i + 1}: ${img.title ?? ''}`} aria-current={i === index}>
              <img src={img.thumbUrl ?? img.url} alt="" loading="lazy" decoding="async" />
            </button>
          </li>
        ))}
      </ul>

      <div className={styles.stage}>
        {badge ? <span className={styles.badge}>{badge}</span> : null}
        {/* Desktop main image */}
        <button type="button" className={styles.main} onClick={() => setViewer(true)} aria-label={`Open image ${index + 1} full screen`}>
          <img
            key={current.url}
            src={current.url}
            srcSet={current.thumbUrl ? `${current.thumbUrl} 400w, ${current.url} 1024w` : undefined}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt={current.alt}
            fetchPriority="high"
            decoding="async"
          />
          <span className={styles.expand} aria-hidden>
            <Expand size={16} />
          </span>
        </button>

        {/* Mobile swipe strip */}
        <div
          className={styles.strip}
          ref={stripRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const i = Math.round(el.scrollLeft / el.clientWidth);
            if (i !== index) setIndex(i);
          }}
        >
          {images.map((img, i) => (
            <button key={img.url} type="button" className={styles.slide} onClick={() => setViewer(true)} aria-label={`Open image ${i + 1} full screen`}>
              <img src={img.url} srcSet={img.thumbUrl ? `${img.thumbUrl} 400w, ${img.url} 1024w` : undefined} sizes="100vw" alt={img.alt} loading={i === 0 ? 'eager' : 'lazy'} decoding="async" />
            </button>
          ))}
        </div>
        <div className={styles.dots} aria-hidden>
          {images.map((img, i) => (
            <span key={img.url} className={cx(styles.dot, i === index && styles.dotOn)} />
          ))}
        </div>

        <div className={styles.arrows}>
          <button type="button" onClick={() => go(index - 1)} aria-label="Previous image">
            <ChevronLeft size={18} aria-hidden />
          </button>
          <button type="button" onClick={() => go(index + 1)} aria-label="Next image">
            <ChevronRight size={18} aria-hidden />
          </button>
        </div>
      </div>

      <Dialog size="lg" open={viewer} onClose={() => { setViewer(false); setZoom(null); }} title={`${name} — ${index + 1} of ${images.length}`}>
        <div className={styles.viewer} onKeyDown={onKey}>
          <button
            type="button"
            className={cx(styles.viewerImage, zoom && styles.zoomed)}
            aria-label={zoom ? 'Zoom out' : 'Zoom in'}
            onClick={(e) => {
              if (zoom) return setZoom(null);
              const r = e.currentTarget.getBoundingClientRect();
              setZoom({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
            }}
            onPointerMove={(e) => {
              if (!zoom) return;
              const r = e.currentTarget.getBoundingClientRect();
              setZoom({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
            }}
          >
            <img src={current.url} alt={current.alt} style={zoom ? { transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined} />
          </button>
          <div className={styles.viewerNav}>
            <button type="button" onClick={() => go(index - 1)} aria-label="Previous image">
              <ChevronLeft size={20} aria-hidden />
            </button>
            <span className="meta tabular">
              {index + 1} / {images.length}
            </span>
            <button type="button" onClick={() => go(index + 1)} aria-label="Next image">
              <ChevronRight size={20} aria-hidden />
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
