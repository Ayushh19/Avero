import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Clock,
  Gift,
  Heart,
  LogOut,
  MapPin,
  MonitorSmartphone,
  Package,
  RotateCcw,
  Shield,
  Star,
  User,
  type LucideIcon,
} from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Overlay';
import { api, errorMessage } from '../../lib/api';
import { useMe, useSignOut } from '../auth/hooks';
import styles from './AccountPage.module.css';

interface Section {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

// Payment methods are intentionally absent: AVERO never stores payment details.
const SECTIONS: Section[] = [
  { to: '/account/orders', label: 'Orders', icon: Package, description: 'Track, cancel or return' },
  { to: '/account/wishlist', label: 'Wishlist', icon: Heart, description: 'Saved for later' },
  { to: '/account/addresses', label: 'Addresses', icon: MapPin, description: 'Delivery addresses' },
  { to: '/account/returns', label: 'Returns', icon: RotateCcw, description: 'Returns, exchanges & refunds' },
  { to: '/account/reviews', label: 'Reviews', icon: Star, description: 'Your reviews' },
  { to: '/account/rewards', label: 'Rewards', icon: Gift, description: 'Points & referrals' },
  { to: '/account/notifications', label: 'Notifications', icon: Bell, description: 'Updates & preferences' },
  { to: '/account/recently-viewed', label: 'Recently viewed', icon: Clock, description: 'Pick up where you left off' },
  { to: '/account/profile', label: 'Profile', icon: User, description: 'Name, phone, preferred size' },
  { to: '/account/security', label: 'Security', icon: Shield, description: 'Password & devices' },
];

export function AccountLayout() {
  const { data: user } = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  if (!user) return null;

  return (
    <main className={`container ${styles.layout}`}>
      <aside className={styles.side}>
        <div className={styles.hello}>
          <p className="eyebrow">My account</p>
          <p className={styles.name}>{user.name}</p>
          <p className="meta">{user.email}</p>
        </div>
        <nav aria-label="Account" className={styles.nav}>
          <NavLink to="/account" end className={({ isActive }) => (isActive ? styles.active : undefined)}>
            Overview
          </NavLink>
          {SECTIONS.map((s) => (
            <NavLink key={s.to} to={s.to} className={({ isActive }) => (isActive ? styles.active : undefined)}>
              {s.label}
            </NavLink>
          ))}
          <button
            type="button"
            className={styles.signOut}
            onClick={() => signOut.mutate(undefined, { onSuccess: () => navigate('/') })}
            disabled={signOut.isPending}
          >
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </nav>
      </aside>
      <div className={styles.content}>
        <Outlet />
      </div>
    </main>
  );
}

function VerifyBanner() {
  const toast = useToast();
  const resend = useMutation({
    mutationFn: () => api.post('/auth/resend-verification'),
    onSuccess: () => toast.success('Verification link sent. Check your inbox.'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className={styles.banner} role="status">
      <div>
        <p className={styles.bannerTitle}>Please verify your email</p>
        <p className="meta">Verifying keeps your account secure and lets you claim past guest orders.</p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => resend.mutate()} loading={resend.isPending}>
        Resend link
      </Button>
    </div>
  );
}

export function AccountOverviewPage() {
  const { data: user } = useMe();
  if (!user) return null;
  return (
    <div className={styles.stack}>
      <header>
        <h1>Hi, {user.name.split(' ')[0]}</h1>
      </header>
      {!user.emailVerified ? <VerifyBanner /> : null}
      <ul role="list" className={styles.cards}>
        {SECTIONS.map(({ to, label, icon: Icon, description }) => (
          <li key={to}>
            <Link to={to} className={styles.card}>
              <Icon size={22} strokeWidth={1.4} aria-hidden />
              <span className={styles.cardTitle}>{label}</span>
              <span className="meta">{description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SessionInfo {
  id: string;
  userAgent: string | null;
  lastSeenAt: string;
  current: boolean;
}

function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function SecurityPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: ({ signal }) => api.get<{ sessions: SessionInfo[] }>('/auth/sessions', signal),
  });
  const signOutOthers = useMutation({
    mutationFn: () => api.delete('/auth/sessions'),
    onSuccess: () => {
      toast.success('Signed out of all other devices');
      return qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className={styles.stack}>
      <header>
        <h1>Security</h1>
        <p className="meta">Devices currently signed in to your account.</p>
      </header>

      {sessions.isPending ? (
        <LoadingRegion label="Loading devices">
          <div className={styles.panel}>
            <Skeleton height={20} width="50%" />
            <Skeleton height={14} width="30%" />
          </div>
        </LoadingRegion>
      ) : sessions.isError ? (
        <ErrorState error={sessions.error} action={<Button onClick={() => sessions.refetch()}>Try again</Button>} />
      ) : (
        <>
          <ul role="list" className={styles.panel}>
            {sessions.data.sessions.map((s) => (
              <li key={s.id} className={styles.device}>
                <MonitorSmartphone size={22} strokeWidth={1.4} aria-hidden />
                <span className={styles.deviceText}>
                  <span className={styles.cardTitle}>{describeDevice(s.userAgent)}</span>
                  <span className="meta">Last active {new Date(s.lastSeenAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </span>
                {s.current ? <Badge tone="success">This device</Badge> : null}
              </li>
            ))}
          </ul>
          {sessions.data.sessions.length > 1 ? (
            <div>
              <Button variant="secondary" onClick={() => signOutOthers.mutate()} loading={signOutOthers.isPending}>
                Sign out of other devices
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
