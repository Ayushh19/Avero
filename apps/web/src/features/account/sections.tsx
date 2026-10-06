import { UK_SIZES, changePasswordSchema, profileSchema, type AddressDto, type AddressInput, type SessionUser } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, MapPin, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Commerce';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../components/ui/Feedback';
import { Field, FormError, SelectField } from '../../components/ui/Form';
import { ProductCard, ProductGrid } from '../../components/ui/Merch';
import { Dialog, useToast } from '../../components/ui/Overlay';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { meQueryKey, useMe } from '../auth/hooks';
import { useRecentlyViewed } from '../recent/recentlyViewed';
import { WishlistCardButton } from '../wishlist/WishlistButton';
import { WishlistContent } from '../wishlist/WishlistPage';
import { AddressForm } from './AddressForm';
import styles from './AccountPage.module.css';

const addressesKey = ['account', 'addresses'] as const;

export function useAddresses({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: addressesKey,
    queryFn: ({ signal }) => api.get<{ addresses: AddressDto[] }>('/account/addresses', signal),
    select: (d) => d.addresses,
    enabled,
  });
}

export function AddressesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const addresses = useAddresses();
  const [editing, setEditing] = useState<AddressDto | 'new' | null>(null);
  const apply = (d: { addresses: AddressDto[] }) => qc.setQueryData(addressesKey, d);

  const save = useMutation({
    mutationFn: (input: AddressInput) =>
      editing && editing !== 'new'
        ? api.put<{ addresses: AddressDto[] }>(`/account/addresses/${editing.id}`, input)
        : api.post<{ addresses: AddressDto[] }>('/account/addresses', input),
    onSuccess: (d) => {
      apply(d);
      setEditing(null);
      toast.success('Address saved');
    },
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => api.post<{ addresses: AddressDto[] }>(`/account/addresses/${id}/default`),
    onSuccess: apply,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ addresses: AddressDto[] }>(`/account/addresses/${id}`),
    onSuccess: (d) => {
      apply(d);
      toast.show('Address removed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className={styles.stack}>
      <header className={styles.sectionHead}>
        <div>
          <h1>Addresses</h1>
          <p className="meta">Saved addresses make checkout a single tap.</p>
        </div>
        {addresses.data?.length ? (
          <Button variant="secondary" icon={<Plus size={16} aria-hidden />} onClick={() => setEditing('new')}>
            Add address
          </Button>
        ) : null}
      </header>

      {addresses.isPending ? (
        <LoadingRegion label="Loading addresses">
          <Skeleton height={140} radius="md" />
        </LoadingRegion>
      ) : addresses.isError ? (
        <ErrorState error={addresses.error} action={<Button onClick={() => addresses.refetch()}>Try again</Button>} />
      ) : addresses.data.length === 0 ? (
        <div className={styles.panel}>
          <EmptyState compact icon={MapPin} title="No saved addresses" body="Add one now, or save it during checkout." action={<Button onClick={() => setEditing('new')}>Add address</Button>} />
        </div>
      ) : (
        <ul role="list" className={styles.addressGrid}>
          {addresses.data.map((a) => (
            <li key={a.id} className={styles.addressCard}>
              <div className={styles.addressTop}>
                <strong>{a.fullName}</strong>
                {a.isDefault ? <Badge>Default</Badge> : null}
              </div>
              <address className={styles.address}>
                {a.line1}
                {a.line2 ? `, ${a.line2}` : ''}
                <br />
                {a.landmark ? (
                  <>
                    Near {a.landmark}
                    <br />
                  </>
                ) : null}
                {a.city}, {a.state} {a.pincode}
                <br />
                {a.phone}
              </address>
              {!a.serviceable ? (
                <p className={styles.warn}>
                  <AlertTriangle size={14} aria-hidden /> We don’t deliver to this PIN code yet.
                </p>
              ) : null}
              <div className={styles.addressActions}>
                <button type="button" onClick={() => setEditing(a)}>
                  Edit
                </button>
                {!a.isDefault ? (
                  <button type="button" onClick={() => makeDefault.mutate(a.id)} disabled={makeDefault.isPending}>
                    Set as default
                  </button>
                ) : null}
                <button type="button" onClick={() => remove.mutate(a.id)} disabled={remove.isPending}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add address' : 'Edit address'}>
        {editing !== null ? (
          <AddressForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? { isDefault: !addresses.data?.length } : editing}
            onSubmit={(input) => save.mutate(input)}
            submitting={save.isPending}
            serverError={save.error ? errorMessage(save.error) : null}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

export function ProfilePage() {
  const { data: user } = useMe();
  if (!user) return null;
  return (
    <div className={styles.stack}>
      <header>
        <h1>Profile</h1>
        <p className="meta">Your preferred size is pre-selected on product pages.</p>
      </header>
      <div className={styles.panel}>
        <ProfileForm user={user} />
      </div>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>{user.hasPassword ? 'Change password' : 'Set a password'}</h2>
        {!user.hasPassword ? <p className="meta">You sign in with Google. Add a password to also sign in with your email.</p> : null}
        <PasswordForm hasPassword={user.hasPassword} />
      </div>
    </div>
  );
}

function ProfileForm({ user }: { user: SessionUser }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (input: unknown) => api.patch<{ user: SessionUser }>('/account/profile', input),
    onSuccess: ({ user: u }) => {
      qc.setQueryData(meQueryKey, { user: u });
      toast.success('Profile updated');
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input = {
      name: String(f.get('name') ?? ''),
      phone: String(f.get('phone') ?? '').trim() || null,
      preferredSize: String(f.get('preferredSize') ?? '') || null,
    };
    const parsed = profileSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      return setErrors(errs);
    }
    setErrors({});
    save.mutate(input);
  };
  const all = { ...errors, ...fieldErrors(save.error) };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Field label="Full name" name="name" defaultValue={user.name} autoComplete="name" error={all.name} />
      <Field label="Email" name="email" defaultValue={user.email} disabled hint={user.emailVerified ? 'Verified' : 'Not verified yet'} />
      <Field label="Mobile number" name="phone" type="tel" inputMode="numeric" defaultValue={user.phone?.replace(/^\+91/, '') ?? ''} autoComplete="tel-national" error={all.phone} />
      <SelectField label="Preferred size (UK/IND)" name="preferredSize" defaultValue={user.preferredSize ?? ''}>
        <option value="">No preference</option>
        {UK_SIZES.map((s) => (
          <option key={s} value={s}>
            UK {s}
          </option>
        ))}
      </SelectField>
      <FormError message={save.error && !Object.keys(all).length ? errorMessage(save.error) : null} />
      <div>
        <Button type="submit" loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (input: unknown) => api.post<{ user: SessionUser }>('/account/password', input),
    onSuccess: ({ user }) => {
      qc.setQueryData(meQueryKey, { user });
      void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
      toast.success('Password updated. Other devices have been signed out.');
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const input = { currentPassword: String(f.get('currentPassword') ?? '') || undefined, newPassword: String(f.get('newPassword') ?? '') };
    const parsed = changePasswordSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      return setErrors(errs);
    }
    setErrors({});
    save.mutate(input, { onSuccess: () => form.reset() });
  };
  const all = { ...errors, ...fieldErrors(save.error) };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {hasPassword ? <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" error={all.currentPassword} /> : null}
      <Field label="New password" name="newPassword" type="password" autoComplete="new-password" hint="At least 8 characters, with a letter and a number" error={all.newPassword} />
      <div>
        <Button type="submit" variant="secondary" loading={save.isPending}>
          {hasPassword ? 'Update password' : 'Set password'}
        </Button>
      </div>
    </form>
  );
}

export function AccountWishlistPage() {
  return (
    <div className={styles.stack}>
      <header>
        <h1>Wishlist</h1>
      </header>
      <WishlistContent />
    </div>
  );
}

export function RecentlyViewedPage() {
  const items = useRecentlyViewed();
  return (
    <div className={styles.stack}>
      <header>
        <h1>Recently viewed</h1>
        <p className="meta">Synced across your devices.</p>
      </header>
      {items.length === 0 ? (
        <div className={styles.panel}>
          <EmptyState compact icon={Clock} title="Nothing here yet" body="Products you look at will show up here." action={<ButtonLink to="/collections/new-arrivals">Start browsing</ButtonLink>} />
        </div>
      ) : (
        <ProductGrid columns={4}>
          {items.map((item) => (
            <li key={item.colorwayId}>
              <ProductCard product={item} wishlistButton={<WishlistCardButton item={item} />} />
            </li>
          ))}
        </ProductGrid>
      )}
    </div>
  );
}
