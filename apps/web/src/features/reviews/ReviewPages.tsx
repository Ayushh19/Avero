import { REVIEW_FITS, type ReviewFit } from '@avero/shared';
import { Gift, MessageSquare } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Rating, StarInput } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Field, FormError, RadioCard, TextareaField } from '../../components/ui/Form';
import { ProductMedia } from '../../components/ui/Merch';
import { Dialog, useToast } from '../../components/ui/Overlay';
import { errorMessage, fieldErrors } from '../../lib/api';
import { reviewDate } from './ProductReviews';
import { useDeleteReview, useMyReviews, useReviewable, useSaveReview, type ReviewInput } from './hooks';
import styles from './Reviews.module.css';

const FIT_COPY: Record<ReviewFit, { title: string; description: string }> = {
  small: { title: 'Runs small', description: 'Consider half a size up' },
  true: { title: 'True to size', description: 'Your usual size fits' },
  large: { title: 'Runs large', description: 'Consider half a size down' },
};

const image = (url: string | null) => (url ? { url, thumbUrl: url, alt: '' } : null);

/* ---------------- /account/reviews ---------------- */

export function AccountReviewsPage() {
  const awaiting = useReviewable();
  const mine = useMyReviews();
  const remove = useDeleteReview();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ id: string; slug: string; name: string } | null>(null);

  return (
    <div className={styles.page}>
      <header>
        <h1>Reviews</h1>
      </header>

      <section className={styles.panel} aria-labelledby="awaiting-h">
        <h2 id="awaiting-h" className={styles.panelTitle}>
          Awaiting your review
        </h2>
        {awaiting.isPending ? (
          <Skeleton height={64} radius="md" />
        ) : awaiting.isError ? (
          <ErrorState error={awaiting.error} />
        ) : awaiting.data.length === 0 ? (
          <p className="meta">Nothing to review right now. Delivered items appear here.</p>
        ) : (
          <>
            <p className="meta">
              <Gift size={14} aria-hidden /> Earn 25 AVERO points for your first review of each product.
            </p>
            <ul role="list" className={styles.rows}>
              {awaiting.data.map((i) => (
                <li key={i.orderItemId} className={styles.row}>
                  <ProductMedia image={image(i.imageUrl)} alt="" radius="md" sizes="64px" />
                  <span className={styles.rowText}>
                    <Link to={i.href}>
                      <strong>{i.productName}</strong>
                    </Link>
                    <span className="meta">
                      {i.colorName} · UK {i.sizeLabel} · order {i.orderNumber}
                    </span>
                  </span>
                  <ButtonLink to={`/account/reviews/new/${i.orderItemId}`} size="sm">
                    Write a review
                  </ButtonLink>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="mine-h">
        <h2 id="mine-h" className={styles.panelTitle}>
          Your reviews
        </h2>
        {mine.isPending ? (
          <Skeleton height={64} radius="md" />
        ) : mine.isError ? (
          <ErrorState error={mine.error} />
        ) : mine.data.length === 0 ? (
          <EmptyState compact icon={MessageSquare} title="No reviews yet" body="Your reviews help other shoppers choose the right pair." />
        ) : (
          <ul role="list" className={styles.rows}>
            {mine.data.map((r) => (
              <li key={r.id} className={styles.row}>
                <ProductMedia image={image(r.imageUrl)} alt="" radius="md" sizes="64px" />
                <span className={styles.rowText}>
                  <Link to={r.href}>
                    <strong>{r.productName}</strong>
                  </Link>
                  <Rating value={r.rating} />
                  <span>{r.title}</span>
                  <span className="meta">
                    {reviewDate(r.createdAt)} · {r.helpfulCount} found this helpful
                  </span>
                </span>
                <span className={styles.rowActions}>
                  <ButtonLink to={`/account/reviews/${r.id}/edit`} variant="secondary" size="sm">
                    Edit
                  </ButtonLink>
                  <Button variant="ghost" size="sm" onClick={() => setConfirm({ id: r.id, slug: r.productSlug, name: r.productName })}>
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title="Delete this review?"
        footer={
          <div className={styles.dialogActions}>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button
              loading={remove.isPending}
              onClick={() =>
                confirm &&
                remove.mutate(
                  { id: confirm.id, productSlug: confirm.slug },
                  {
                    onSuccess: () => {
                      toast.success('Review deleted');
                      setConfirm(null);
                    },
                  },
                )
              }
            >
              Delete review
            </Button>
          </div>
        }
      >
        <p>Your review of {confirm?.name} will be removed. You can write a new one later; the review points you already earned stay with you.</p>
        <FormError message={remove.error ? errorMessage(remove.error) : null} />
      </Dialog>
    </div>
  );
}

/* ---------------- write / edit ---------------- */

export function ReviewFormPage() {
  const { orderItemId, reviewId } = useParams();
  const awaiting = useReviewable(Boolean(orderItemId));
  const mine = useMyReviews(Boolean(reviewId));
  const loading = orderItemId ? awaiting.isPending : mine.isPending;
  const error = orderItemId ? awaiting.error : mine.error;

  if (loading) {
    return (
      <LoadingRegion label="Loading">
        <Skeleton width="40%" height={36} />
        <Skeleton height={320} radius="md" />
      </LoadingRegion>
    );
  }
  if (error) return <ErrorState error={error} />;

  const item = orderItemId ? awaiting.data?.find((i) => i.orderItemId === orderItemId) : undefined;
  const existing = reviewId ? mine.data?.find((r) => r.id === reviewId) : undefined;
  if (!item && !existing) {
    return (
      <EmptyState
        icon={MessageSquare}
        title={orderItemId ? 'This item can’t be reviewed' : 'Review not found'}
        body={orderItemId ? 'It may already be reviewed, or it hasn’t been delivered yet.' : undefined}
        action={<ButtonLink to="/account/reviews">Your reviews</ButtonLink>}
      />
    );
  }
  const product = item
    ? { name: item.productName, slug: item.productSlug, meta: `${item.colorName} · UK ${item.sizeLabel}`, image: item.imageUrl, href: item.href }
    : { name: existing!.productName, slug: existing!.productSlug, meta: `${existing!.colorName} · UK ${existing!.sizePurchased}`, image: existing!.imageUrl, href: existing!.href };

  return (
    <ReviewForm
      key={reviewId ?? orderItemId}
      product={product}
      orderItemId={orderItemId}
      reviewId={reviewId}
      initial={existing ? { rating: existing.rating, title: existing.title, body: existing.body, fit: existing.fit } : undefined}
    />
  );
}

function ReviewForm({
  product,
  orderItemId,
  reviewId,
  initial,
}: {
  product: { name: string; slug: string; meta: string; image: string | null; href: string };
  orderItemId?: string;
  reviewId?: string;
  initial?: ReviewInput;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const save = useSaveReview();
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [fit, setFit] = useState<ReviewFit | null>(initial?.fit ?? null);
  const [ratingError, setRatingError] = useState<string>();
  const errs = fieldErrors(save.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!rating) return setRatingError('Choose a star rating');
    setRatingError(undefined);
    save.mutate(
      { input: { rating, title, body, fit }, orderItemId, reviewId, productSlug: product.slug },
      {
        onSuccess: () => {
          toast.success(reviewId ? 'Review updated' : 'Thanks! Your review is live');
          navigate('/account/reviews');
        },
      },
    );
  };

  return (
    <div className={styles.page}>
      <Link to="/account/reviews" className={styles.back}>
        ← Reviews
      </Link>
      <h1>{reviewId ? 'Edit your review' : 'Write a review'}</h1>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.product}>
          <ProductMedia image={image(product.image)} alt="" radius="md" sizes="72px" />
          <span>
            <Link to={product.href}>
              <strong>{product.name}</strong>
            </Link>
            <br />
            <span className="meta">{product.meta}</span>
          </span>
        </div>
        <StarInput value={rating} onChange={setRating} error={ratingError ?? errs.rating} />
        <fieldset className={styles.fitChoices}>
          <legend className={styles.fitLegend}>
            How does it fit? (optional)
          </legend>
          {REVIEW_FITS.map((f) => (
            <RadioCard key={f} name="fit" value={f} checked={fit === f} onChange={() => setFit(f)} title={FIT_COPY[f].title} description={FIT_COPY[f].description} />
          ))}
        </fieldset>
        <Field label="Title" name="title" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} error={errs.title} hint="Sum it up in a few words" />
        <TextareaField
          label="Your review"
          name="body"
          rows={6}
          maxLength={2000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          error={errs.body}
          hint="Comfort, fit, how they’ve held up — what would you tell a friend?"
        />
        {!errs.title && !errs.body && !errs.rating ? <FormError message={save.error ? errorMessage(save.error) : null} /> : null}
        <div className={styles.actions}>
          <Button type="submit" loading={save.isPending}>
            {reviewId ? 'Save changes' : 'Post review'}
          </Button>
          <ButtonLink to="/account/reviews" variant="ghost">
            Cancel
          </ButtonLink>
        </div>
        {!reviewId ? <p className="meta">Reviews are public and show your first name and last initial. Your first review of this product earns 25 points.</p> : null}
      </form>
    </div>
  );
}
