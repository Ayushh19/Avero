import { formatINR, type LedgerEntryDto } from '@avero/shared';
import { Check, Copy, Gift, Share2, Ticket, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Overlay';
import { cx } from '../../lib/cx';
import { useMe } from '../auth/hooks';
import { useLoyalty, useReferralCode, useReferrals } from './hooks';
import styles from './Loyalty.module.css';

const date = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const KIND_LABEL: Record<LedgerEntryDto['kind'], string> = {
  earn: 'Earned on order',
  redeem: 'Used at checkout',
  reverse: 'Returned',
  expire: 'Expired',
  bonus: 'Bonus',
  referral: 'Referral reward',
  refund_credit: 'Refund as points',
};

function Loading() {
  return (
    <LoadingRegion label="Loading">
      <Skeleton width="40%" height={36} />
      <Skeleton height={180} radius="md" />
      <Skeleton height={240} radius="md" />
    </LoadingRegion>
  );
}

/* ---------------- /account/rewards ---------------- */

export function RewardsPage() {
  const loyalty = useLoyalty();
  if (loyalty.isPending) return <Loading />;
  if (loyalty.isError) return <ErrorState error={loyalty.error} action={<Button onClick={() => loyalty.refetch()}>Try again</Button>} />;
  const l = loyalty.data;
  const toNext = 100 - (l.balance % 100);
  const pct = ((l.balance % 100) / 100) * 100;

  return (
    <div className={styles.page}>
      <header>
        <h1>Rewards</h1>
      </header>

      <section className={styles.balanceCard} aria-label="Points balance">
        <div>
          <p className="eyebrow">Available points</p>
          <p className={styles.balance}>{l.balance.toLocaleString('en-IN')}</p>
          <p className="meta">Worth {formatINR(l.balance * l.pointValuePaise)} at checkout · up to {l.maxRedeemPercent}% of an order</p>
        </div>
        <div className={styles.progress}>
          <p className={styles.progressText}>
            {toNext === 100 && l.balance > 0 ? 'You have a full ₹100 to spend' : `${toNext} more points to your next ₹100 off`}
          </p>
          <div className={styles.track} role="progressbar" aria-label="Progress to the next ₹100" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <span style={{ width: `${toNext === 100 && l.balance > 0 ? 100 : pct}%` }} />
          </div>
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>Pending</dt>
            <dd>{l.pending.toLocaleString('en-IN')}</dd>
          </div>
          <div>
            <dt>Expiring in 30 days</dt>
            <dd>{l.expiringSoon.reduce((s, e) => s + e.points, 0).toLocaleString('en-IN')}</dd>
          </div>
        </dl>
      </section>

      {l.expiringSoon.length ? (
        <p className={styles.notice} role="status">
          {l.expiringSoon.map((e) => `${e.points} points expire on ${date(e.on)}`).join(' · ')}. Use them at checkout.
        </p>
      ) : null}

      {l.coupons.length ? (
        <section className={styles.panel} aria-labelledby="coupons-h">
          <h2 id="coupons-h" className={styles.panelTitle}>
            Your offers
          </h2>
          <ul role="list" className={styles.coupons}>
            {l.coupons.map((c) => (
              <li key={c.code} className={styles.coupon}>
                <Ticket size={18} aria-hidden />
                <span>
                  <strong className={styles.code}>{c.code}</strong>
                  <br />
                  <span className="meta">
                    {c.description}
                    {c.endsAt ? ` · valid until ${date(c.endsAt)}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="meta">Apply it at checkout — it’s already waiting for you there.</p>
        </section>
      ) : null}

      <section className={styles.panel} aria-labelledby="how-h">
        <h2 id="how-h" className={styles.panelTitle}>
          How it works
        </h2>
        <ul role="list" className={styles.how}>
          <li>
            <strong>1 point for every ₹100</strong> you pay (excluding shipping). Points become available once the return window closes.
          </li>
          <li>
            <strong>25 points</strong> for your first review of each product.
          </li>
          <li>
            <strong>250 points</strong> when a friend you invite completes their first order. <Link to="/account/referrals">Invite friends</Link>
          </li>
          <li>Points expire 12 months after they become available. Points you get back as a refund never expire.</li>
        </ul>
      </section>

      <section className={styles.panel} aria-labelledby="history-h">
        <h2 id="history-h" className={styles.panelTitle}>
          History
        </h2>
        {l.ledger.length === 0 ? (
          <EmptyState compact icon={Gift} title="No points yet" body="Your first order earns points once its return window closes." action={<ButtonLink to="/">Start shopping</ButtonLink>} />
        ) : (
          <ul role="list" className={styles.ledger}>
            {l.ledger.map((e) => (
              <li key={e.id}>
                <span className={styles.ledgerText}>
                  <span>
                    {KIND_LABEL[e.kind]}
                    {e.orderNumber ? (
                      <>
                        {' · '}
                        <Link to={`/account/orders/${e.orderNumber}`}>{e.orderNumber}</Link>
                      </>
                    ) : null}
                  </span>
                  <span className="meta">
                    {date(e.createdAt)}
                    {e.note && e.kind === 'bonus' ? ` · ${e.note}` : ''}
                    {e.status === 'pending' ? ' · available after the return window' : e.expiresAt && e.delta > 0 ? ` · expires ${date(e.expiresAt)}` : ''}
                  </span>
                </span>
                <span className={styles.ledgerRight}>
                  {e.status === 'pending' ? <Badge tone="warning">Pending</Badge> : null}
                  <strong className={cx('tabular', e.delta > 0 ? styles.plus : styles.minus)}>
                    {e.delta > 0 ? '+' : '−'}
                    {Math.abs(e.delta).toLocaleString('en-IN')}
                  </strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------------- /account/referrals ---------------- */

const INVITE_STATUS = {
  signed_up: { label: 'Joined', tone: 'neutral' },
  ordered: { label: 'Ordered — reward pending', tone: 'warning' },
  rewarded: { label: 'Rewarded', tone: 'success' },
  void: { label: 'Not eligible', tone: 'neutral' },
} as const;

export function ReferralsPage() {
  const referrals = useReferrals();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  if (referrals.isPending) return <Loading />;
  if (referrals.isError) return <ErrorState error={referrals.error} action={<Button onClick={() => referrals.refetch()}>Try again</Button>} />;
  const r = referrals.data;
  const share = `Get ${formatINR(r.offer.refereeDiscountPaise)} off your first AVERO order: ${r.link}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.link);
      setCopied(true);
      toast.success('Link copied');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Couldn’t copy — select the link and copy it instead');
    }
  };
  const nativeShare = async () => {
    try {
      await navigator.share({ title: 'AVERO', text: share, url: r.link });
    } catch {
      // cancelled
    }
  };

  return (
    <div className={styles.page}>
      <header>
        <h1>Referrals</h1>
      </header>
      <section className={styles.inviteCard} aria-label="Invite friends">
        <p className="eyebrow">Give {formatINR(r.offer.refereeDiscountPaise)}, get {r.offer.referrerRewardPoints} points</p>
        <h2 className={styles.inviteTitle}>Invite friends to AVERO</h2>
        <p>
          Friends get {formatINR(r.offer.refereeDiscountPaise)} off their first order of {formatINR(r.offer.refereeMinOrderPaise)} or more. You get{' '}
          {r.offer.referrerRewardPoints} points (worth {formatINR(r.offer.referrerRewardPoints * 100)}) once their order clears its return window.
        </p>
        <div className={styles.linkRow}>
          <input className={styles.linkInput} value={r.link} readOnly aria-label="Your referral link" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="secondary" onClick={() => void copy()} icon={copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {typeof navigator !== 'undefined' && 'share' in navigator ? (
            <Button variant="secondary" onClick={() => void nativeShare()} icon={<Share2 size={16} aria-hidden />}>
              Share
            </Button>
          ) : null}
        </div>
        <p className="meta">
          Or share your code <strong className={styles.code}>{r.code}</strong>
        </p>
      </section>

      <section className={styles.panel} aria-labelledby="invites-h">
        <div className={styles.panelHead}>
          <h2 id="invites-h" className={styles.panelTitle}>
            Your invites
          </h2>
          {r.pointsEarned ? <p className="meta">{r.pointsEarned.toLocaleString('en-IN')} points earned so far</p> : null}
        </div>
        {r.invites.length === 0 ? (
          <EmptyState compact icon={Users} title="No invites yet" body="Friends who join with your link show up here." />
        ) : (
          <ul role="list" className={styles.ledger}>
            {r.invites.map((i) => (
              <li key={`${i.name}-${i.joinedAt}`}>
                <span className={styles.ledgerText}>
                  <span>{i.name}</span>
                  <span className="meta">
                    Joined {date(i.joinedAt)}
                    {i.rewardedAt ? ` · rewarded ${date(i.rewardedAt)}` : ''}
                  </span>
                </span>
                <Badge tone={INVITE_STATUS[i.status].tone}>{INVITE_STATUS[i.status].label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------------- /r/:code ---------------- */

export function ReferralLandingPage() {
  const { code } = useParams();
  const check = useReferralCode(code);
  const { data: user } = useMe();
  if (user) return <Navigate to="/" replace />;
  return (
    <main className={`container ${styles.landing}`}>
      {check.isPending ? (
        <Skeleton height={280} radius="lg" />
      ) : check.data?.valid ? (
        <section className={styles.landingCard}>
          <Gift size={36} strokeWidth={1.4} aria-hidden className={styles.landingIcon} />
          <p className="eyebrow">A gift from {check.data.referrerName}</p>
          <h1>{formatINR(check.data.offer.refereeDiscountPaise)} off your first pair</h1>
          <p className={styles.landingBody}>
            Create your AVERO account and get {formatINR(check.data.offer.refereeDiscountPaise)} off your first order of {formatINR(check.data.offer.refereeMinOrderPaise)} or more. Your
            code is applied to your account automatically.
          </p>
          <div className={styles.landingActions}>
            <ButtonLink to={`/signup?ref=${encodeURIComponent(code!)}&returnTo=/`} size="lg">
              Create account
            </ButtonLink>
            <ButtonLink to="/" variant="secondary" size="lg">
              Browse first
            </ButtonLink>
          </div>
          <p className="meta">For new AVERO customers only.</p>
        </section>
      ) : (
        <EmptyState icon={Gift} title="This invite link isn’t valid" body="Check the link with the friend who sent it — or explore AVERO anyway." action={<ButtonLink to="/">Shop AVERO</ButtonLink>} />
      )}
    </main>
  );
}
