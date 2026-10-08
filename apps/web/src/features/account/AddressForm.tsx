import { INDIAN_STATES, addressSchema, type AddressDto, type AddressInput } from '@avero/shared';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Feedback';
import { Checkbox, Field, FormError, SelectField } from '../../components/ui/Form';
import { api } from '../../lib/api';
import type { PickedAddress } from './MapPicker';
import styles from './AddressForm.module.css';

// Leaflet + map tiles load only when the shopper opens the map.
const MapPicker = lazy(() => import('./MapPicker').then((m) => ({ default: m.MapPicker })));

interface PincodeInfo {
  valid: boolean;
  serviceable: boolean;
  city: string | null;
  state: string | null;
}

type Draft = Record<keyof AddressInput, string | boolean | undefined>;

/** Shared by the address book and checkout. PIN code auto-fills state/city and checks serviceability. */
export function AddressForm({
  initial,
  onSubmit,
  submitting,
  serverError,
  submitLabel = 'Save address',
  showDefault = true,
  onCancel,
}: {
  initial?: Partial<AddressDto>;
  onSubmit: (input: AddressInput) => void;
  submitting?: boolean;
  serverError?: string | null;
  submitLabel?: string;
  showDefault?: boolean;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    fullName: initial?.fullName ?? '',
    phone: initial?.phone?.replace(/^\+91/, '') ?? '',
    line1: initial?.line1 ?? '',
    line2: initial?.line2 ?? '',
    landmark: initial?.landmark ?? '',
    city: initial?.city ?? '',
    state: initial?.state ?? '',
    pincode: initial?.pincode ?? '',
    isDefault: initial?.isDefault ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [mapOpen, setMapOpen] = useState(false);
  const set = (k: keyof AddressInput) => (v: string | boolean) => setDraft((d) => ({ ...d, [k]: v }));

  const pin = String(draft.pincode ?? '');
  const pinInfo = useQuery({
    queryKey: ['pincode', pin],
    queryFn: ({ signal }) => api.get<PincodeInfo>(`/pincodes/${pin}`, signal),
    enabled: /^[1-9]\d{5}$/.test(pin),
    staleTime: Infinity,
  });
  // Auto-fill state/city from the PIN code when the shopper hasn't typed them.
  const info = pinInfo.data;
  if (info?.valid && info.state && !draft.state && (INDIAN_STATES as readonly string[]).includes(info.state)) {
    setDraft((d) => ({ ...d, state: info.state!, city: d.city || info.city || '' }));
  }

  // The pin is an explicit choice, so it replaces area/city/state/PIN; house details are kept if typed.
  const usePicked = (p: PickedAddress) => {
    setDraft((d) => ({
      ...d,
      line1: d.line1 || p.line1 || '',
      line2: p.line2 ?? d.line2,
      city: p.city ?? d.city,
      state: p.state ?? d.state,
      pincode: p.pincode ?? d.pincode,
    }));
    setErrors({});
    setMapOpen(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
    const parsed = addressSchema.safeParse(clean);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  };

  const field = (k: keyof AddressInput) => ({
    name: k,
    value: String(draft[k] ?? ''),
    onChange: (e: { target: { value: string } }) => set(k)(e.target.value),
    error: errors[k],
  });

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {mapOpen ? (
        <Suspense fallback={<Skeleton height={380} radius="md" />}>
          <MapPicker near={pin || String(draft.city ?? '') || undefined} onPick={usePicked} onClose={() => setMapOpen(false)} />
        </Suspense>
      ) : (
        <div>
          <Button size="sm" variant="secondary" icon={<MapPin size={14} aria-hidden />} onClick={() => setMapOpen(true)}>
            Pick location on map
          </Button>
        </div>
      )}
      <div className={styles.grid}>
        <Field label="Full name" autoComplete="name" {...field('fullName')} />
        <Field label="Mobile number" type="tel" inputMode="numeric" autoComplete="tel-national" hint="For delivery updates" {...field('phone')} />
        <Field
          label="PIN code"
          inputMode="numeric"
          maxLength={6}
          autoComplete="postal-code"
          {...field('pincode')}
          hint={
            info && !info.serviceable && info.valid
              ? undefined
              : info?.serviceable
                ? `Delivers to ${info.city ?? info.state ?? 'this area'}`
                : undefined
          }
          error={errors.pincode ?? (info && info.valid && !info.serviceable ? 'We don’t deliver to this PIN code yet' : undefined)}
        />
        <Field label="City" autoComplete="address-level2" {...field('city')} />
        <div className={styles.full}>
          <Field label="House / flat, building" autoComplete="address-line1" {...field('line1')} />
        </div>
        <div className={styles.full}>
          <Field label="Area, street (optional)" autoComplete="address-line2" {...field('line2')} />
        </div>
        <Field label="Landmark (optional)" {...field('landmark')} />
        <SelectField label="State" name="state" value={String(draft.state ?? '')} onChange={(e) => set('state')(e.target.value)} error={errors.state} autoComplete="address-level1">
          <option value="" disabled>
            Choose a state
          </option>
          {INDIAN_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectField>
      </div>
      {showDefault ? <Checkbox label="Make this my default address" checked={Boolean(draft.isDefault)} onChange={(e) => set('isDefault')(e.target.checked)} /> : null}
      <FormError message={serverError} />
      <div className={styles.actions}>
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
