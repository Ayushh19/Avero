import type { ReviewDto, ReviewListDto } from '@avero/shared';
import { BadgeCheck, MessageSquare, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Rating } from '../../components/ui/Commerce';
import { EmptyState, Skeleton } from '../../components/ui/Feedback';
import { InlineSelect } from '../../components/ui/Form';
import { cx } from '../../lib/cx';
import { useMe } from '../auth/hooks';
import { useHelpful, useProductReviews, type ReviewSort } from './hooks';
import styles from './Reviews.module.css';

const SORTS: { value: ReviewSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'helpful', label: 'Most helpful' },
  { value: 'rating_high', label: 'Highest rated' },
  { value: 'rating_low', label: 'Lowest rated' },
];
const FIT_LABEL = { small: 'Runs small', true: 'True to size', large: 'Runs large' } as const;

export const reviewDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Product page reviews: summary + distribution filter, fit, sort, verified list, helpful votes. */
export function ProductReviews({ slug }: { slug: string }) {
  const [sort, setSort] = useState<ReviewSort>('recent');
  const [rating, setRating] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const reviews = useProductReviews(slug, { sort, rating, page });
  const d = reviews.data;

  if (reviews.isPending) {
    return (
      <div className={styles.section} aria-busy>
        <Skeleton height={120} radius="md" />
        <Skeleton height={160} radius="md" />
      </div>
    );
  }
  if (!d) return null;

  if (d.summary.count === 0) {
    return (
      <div className={styles.section}>
        <EmptyState compact icon={MessageSquare} title="No reviews yet" body="Reviews on AVERO come only from verified buyers, after delivery." />
        <ReviewCta data={d} />
      </div>
    );
  }

  const filter = (n: number | undefined) => {
    setRating(n);
    setPage(1);
  };

  return (
    <div className={styles.section}>
      <h2 className="visually-hidden">Customer reviews</h2>
      <div className={styles.summary}>
        <div className={styles.score}>
          <p className={styles.average}>{d.summary.average.toFixed(1)}</p>
          <Rating value={d.summary.average} size="md" showValue={false} />
          <p className="meta">
            {d.summary.count} verified {d.summary.count === 1 ? 'review' : 'reviews'}
          </p>
        </div>
        <ol role="list" className={styles.bars} aria-label="Filter by rating">
          {[5, 4, 3, 2, 1].map((n) => {
            const count = d.summary.distribution[n - 1] ?? 0;
            const pct = d.summary.count ? Math.round((count / d.summary.count) * 100) : 0;
            return (
              <li key={n}>
                <button
                  type="button"
                  className={cx(styles.bar, rating === n && styles.barOn)}
                  aria-pressed={rating === n}
                  disabled={count === 0}
                  onClick={() => filter(rating === n ? undefined : n)}
                  aria-label={`${n} star: ${count} ${count === 1 ? 'review' : 'reviews'}${rating === n ? ' (showing)' : ''}`}
                >
                  <span className={styles.barLabel}>{n} ★</span>
                  <span className={styles.track} aria-hidden>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className={styles.barCount}>{count}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <FitScale fit={d.summary.fit} />
      </div>

      <div className={styles.toolbar}>
        <p className="meta" aria-live="polite">
          {rating ? (
            <>
              Showing {rating}-star reviews ·{' '}
              <button type="button" className={styles.textButton} onClick={() => filter(undefined)}>
                Show all
              </button>
            </>
          ) : (
            'All reviews'
          )}
        </p>
        <InlineSelect
          label="Sort by"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as ReviewSort);
            setPage(1);
          }}
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </InlineSelect>
      </div>

      <ul role="list" className={cx(styles.list, reviews.isPlaceholderData && styles.loading)}>
        {d.reviews.map((r) => (
          <ReviewItem key={r.id} review={r} slug={slug} />
        ))}
      </ul>

      {d.pageCount > 1 ? (
        <nav className={styles.pager} aria-label="Review pages">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="meta">
            Page {d.page} of {d.pageCount}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= d.pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </nav>
      ) : null}

      <ReviewCta data={d} />
    </div>
  );
}

function FitScale({ fit }: { fit: ReviewListDto['summary']['fit'] }) {
  const total = fit.small + fit.true + fit.large;
  if (!total) return null;
  // Position on a small ← true → large scale, from the votes.
  const position = ((fit.true * 50 + fit.large * 100) / total).toFixed(0);
  const top = (Object.keys(FIT_LABEL) as (keyof typeof FIT_LABEL)[]).sort((a, b) => fit[b] - fit[a])[0]!;
  return (
    <div className={styles.fit}>
      <p className={styles.fitTitle}>
        Fit: <strong>{FIT_LABEL[top]}</strong>
      </p>
      <div className={styles.fitScale} aria-hidden>
        <span className={styles.fitMarker} style={{ left: `${position}%` }} />
      </div>
      <div className={styles.fitLabels} aria-hidden>
        <span>Small</span>
        <span>True to size</span>
        <span>Large</span>
      </div>
      <p className="visually-hidden">
        {Math.round((fit.true / total) * 100)}% say true to size, {Math.round((fit.small / total) * 100)}% runs small, {Math.round((fit.large / total) * 100)}% runs large.
      </p>
    </div>
  );
}

function ReviewItem({ review: r, slug }: { review: ReviewDto; slug: string }) {
  const { data: user } = useMe();
  const helpful = useHelpful(slug);
  const location = useLocation();
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <Rating value={r.rating} />
        <span className="meta">{reviewDate(r.createdAt)}</span>
      </div>
      <h3 className={styles.itemTitle}>{r.title}</h3>
      <p className={styles.itemBody}>{r.body}</p>
      <p className={styles.itemMeta}>
        <span className={styles.verified}>
          <BadgeCheck size={14} aria-hidden /> Verified buyer
        </span>
        <span>
          {r.authorName} · {r.colorName}, UK {r.sizePurchased}
          {r.fit ? ` · ${FIT_LABEL[r.fit]}` : ''}
        </span>
      </p>
      <div className={styles.itemActions}>
        {r.mine ? (
          <span className="meta">Your review</span>
        ) : user ? (
          <button
            type="button"
            className={cx(styles.helpful, r.votedHelpful && styles.helpfulOn)}
            aria-pressed={r.votedHelpful}
            onClick={() => helpful.mutate({ id: r.id, helpful: !r.votedHelpful })}
          >
            <ThumbsUp size={14} aria-hidden /> Helpful{r.helpfulCount ? ` (${r.helpfulCount})` : ''}
          </button>
        ) : (
          <span className="meta">
            {r.helpfulCount ? `${r.helpfulCount} found this helpful · ` : ''}
            <Link to={`/signin?returnTo=${encodeURIComponent(location.pathname)}`}>Sign in</Link> to vote
          </span>
        )}
      </div>
    </li>
  );
}

function ReviewCta({ data }: { data: ReviewListDto }) {
  const { data: user } = useMe();
  const location = useLocation();
  if (data.canReview) {
    return (
      <div className={styles.cta}>
        <p>You bought this — tell other shoppers how it fits.</p>
        <ButtonLink to={`/account/reviews/new/${data.canReview.orderItemId}`} variant="secondary">
          Write a review
        </ButtonLink>
      </div>
    );
  }
  if (data.myReviewId) {
    return (
      <div className={styles.cta}>
        <p>Thanks for reviewing this product.</p>
        <ButtonLink to={`/account/reviews/${data.myReviewId}/edit`} variant="ghost">
          Edit your review
        </ButtonLink>
      </div>
    );
  }
  if (!user) {
    return (
      <p className={cx('meta', styles.ctaNote)}>
        Bought these? <Link to={`/signin?returnTo=${encodeURIComponent(location.pathname)}`}>Sign in</Link> to write a review once they’ve been delivered.
      </p>
    );
  }
  return null;
}
