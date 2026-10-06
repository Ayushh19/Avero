import type { NotificationDto, NotificationKind } from '@avero/shared';
import { Bell, BellOff } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Drawer } from '../../components/ui/Overlay';
import { cx } from '../../lib/cx';
import { timeAgo, useMarkRead, useNotificationPages, useNotifications, usePreferences, useSetPreference } from './hooks';
import styles from './Notifications.module.css';

const KIND_LABEL: Record<NotificationKind, string> = {
  order: 'Orders & delivery',
  payment: 'Payments',
  refund: 'Refunds',
  return: 'Returns & exchanges',
  stock_alert: 'Back in stock',
  price_drop: 'Price drops',
  review_prompt: 'Review reminders',
  points: 'Rewards points',
  referral: 'Referrals',
  account: 'Account & security',
};

function NotificationList({
  items,
  onOpen,
}: {
  items: NotificationDto[];
  onOpen: (n: NotificationDto) => void;
}) {
  return (
    <ul role="list" className={styles.list}>
      {items.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            className={cx(styles.item, !n.readAt && styles.unread)}
            onClick={() => onOpen(n)}
          >
            <span className={styles.dot} aria-hidden />
            <span className={styles.text}>
              <span className={styles.title}>
                {n.title}
                {!n.readAt ? <span className="visually-hidden"> (unread)</span> : null}
              </span>
              <span className={styles.body}>{n.body}</span>
              <span className={styles.time}>{timeAgo(n.createdAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function useOpenNotification(after?: () => void) {
  const markRead = useMarkRead();
  const navigate = useNavigate();
  return (n: NotificationDto) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    after?.();
    if (n.link) navigate(n.link);
  };
}

/** Header bell: unread badge + drawer with the latest notifications. Signed-in only. */
export function NotificationBell({
  className,
  countClassName,
}: {
  className?: string;
  countClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const notes = useNotifications();
  const markRead = useMarkRead();
  const openOne = useOpenNotification(() => setOpen(false));
  const unread = notes.data?.unreadCount ?? 0;
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Bell size={20} strokeWidth={1.6} aria-hidden />
        {unread ? (
          <span className={countClassName} aria-hidden>
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
        footer={
          <div className={styles.drawerFoot}>
            <Link to="/account/notifications" onClick={() => setOpen(false)}>
              All notifications & settings
            </Link>
            {unread ? (
              <Button variant="ghost" size="sm" onClick={() => markRead.mutate({ all: true })}>
                Mark all as read
              </Button>
            ) : null}
          </div>
        }
      >
        {notes.isPending ? (
          <LoadingRegion label="Loading notifications">
            <Skeleton height={64} radius="md" />
          </LoadingRegion>
        ) : notes.data?.notifications.length ? (
          <NotificationList items={notes.data.notifications.slice(0, 15)} onOpen={openOne} />
        ) : (
          <EmptyState
            compact
            icon={BellOff}
            title="You’re all caught up"
            body="Order updates, refunds and back-in-stock alerts show up here."
          />
        )}
      </Drawer>
    </>
  );
}

/** /account/notifications */
export function NotificationsPage() {
  const notes = useNotifications();
  const pages = useNotificationPages();
  const all = pages.data?.pages.flatMap((p) => p.notifications) ?? [];
  const markRead = useMarkRead();
  const openOne = useOpenNotification();
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>Notifications</h1>
        {notes.data?.unreadCount ? (
          <Button variant="secondary" size="sm" onClick={() => markRead.mutate({ all: true })}>
            Mark all as read
          </Button>
        ) : null}
      </header>
      <section className={styles.panel} aria-label="Notifications">
        {pages.isPending ? (
          <LoadingRegion label="Loading notifications">
            <Skeleton height={64} radius="md" />
          </LoadingRegion>
        ) : pages.isError ? (
          <ErrorState error={pages.error} action={<Button onClick={() => pages.refetch()}>Try again</Button>} />
        ) : all.length ? (
          <>
            <NotificationList items={all} onOpen={openOne} />
            {pages.hasNextPage ? (
              <div className={styles.more}>
                <Button variant="secondary" loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState compact icon={BellOff} title="No notifications yet" body="We’ll let you know about orders, refunds and items you’re watching." />
        )}
      </section>
      <Preferences />
    </div>
  );
}

function Preferences() {
  const prefs = usePreferences();
  const set = useSetPreference();
  // Synchronous local state so a toggle shows the moment it's clicked.
  const [local, setLocal] = useState<
    Partial<Record<NotificationKind, { inApp: boolean; email: boolean }>>
  >({});
  const change = (kind: NotificationKind, next: { inApp: boolean; email: boolean }) => {
    setLocal((l) => ({ ...l, [kind]: next }));
    set.mutate(
      { kind, ...next },
      { onSettled: () => setLocal((l) => ({ ...l, [kind]: undefined })) },
    );
  };
  return (
    <section className={styles.panel} aria-labelledby="prefs-h">
      <div>
        <h2 id="prefs-h" className={styles.panelTitle}>
          Preferences
        </h2>
        <p className="meta">
          Emails about your orders, payments, refunds, returns and account are always sent.
        </p>
      </div>
      {prefs.isPending ? (
        <Skeleton height={200} radius="md" />
      ) : prefs.isError ? (
        <ErrorState error={prefs.error} />
      ) : (
        <table className={styles.prefs}>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">In app</th>
              <th scope="col">Email</th>
            </tr>
          </thead>
          <tbody>
            {prefs.data.map((server) => {
              const p = { ...server, ...local[server.kind] };
              return (
                <tr key={p.kind}>
                  <th scope="row">{KIND_LABEL[p.kind]}</th>
                  <td>
                    <input
                      type="checkbox"
                      className={styles.toggle}
                      aria-label={`${KIND_LABEL[p.kind]} in app`}
                      checked={p.inApp}
                      onChange={(e) => change(p.kind, { inApp: e.target.checked, email: p.email })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      className={styles.toggle}
                      aria-label={`${KIND_LABEL[p.kind]} by email`}
                      checked={p.email}
                      disabled={p.emailLocked}
                      title={p.emailLocked ? 'Always sent' : undefined}
                      onChange={(e) => change(p.kind, { inApp: p.inApp, email: e.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
