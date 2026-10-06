import { AlertTriangle, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { ApiError } from '../../lib/api';
import styles from './Feedback.module.css';

interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  ratio?: string;
  radius?: 'sm' | 'md' | 'lg' | 'full';
  className?: string;
}

export function Skeleton({ width, height = 16, ratio, radius = 'sm', className }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cx(styles.skeleton, styles[`r-${radius}`], className)}
      style={{ width, height: ratio ? undefined : height, aspectRatio: ratio }}
    />
  );
}

export function ProductCardSkeleton() {
  return (
    <div className={styles.cardSkeleton} aria-hidden>
      <Skeleton ratio="1/1" radius="md" />
      <Skeleton width="70%" />
      <Skeleton width="45%" height={12} />
      <Skeleton width="30%" />
    </div>
  );
}

/** Wrap skeleton regions so screen readers announce a single loading message. */
export function LoadingRegion({ label = 'Loading', children }: { label?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="visually-hidden">{label}…</span>
      {children}
    </div>
  );
}

interface StateProps {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon: Icon, title, body, action, compact }: StateProps) {
  return (
    <div className={cx(styles.state, compact && styles.compact)}>
      {Icon ? (
        <span className={styles.stateIcon}>
          <Icon size={26} strokeWidth={1.4} aria-hidden />
        </span>
      ) : null}
      <h2 className={styles.stateTitle}>{title}</h2>
      {body ? <p className={styles.stateBody}>{body}</p> : null}
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, title = "We couldn't load this", action }: { error?: unknown; title?: string; action?: ReactNode }) {
  const reference = error instanceof ApiError ? error.requestId : undefined;
  const message =
    error instanceof ApiError
      ? error.message
      : 'Something went wrong on our side. Please try again in a moment.';
  return (
    <div className={styles.state} role="alert">
      <span className={cx(styles.stateIcon, styles.stateIconError)}>
        <AlertTriangle size={24} strokeWidth={1.4} aria-hidden />
      </span>
      <h2 className={styles.stateTitle}>{title}</h2>
      <p className={styles.stateBody}>{message}</p>
      {action ? <div className={styles.stateAction}>{action}</div> : null}
      {reference ? <p className="meta">Reference: {reference.slice(0, 8)}</p> : null}
    </div>
  );
}
