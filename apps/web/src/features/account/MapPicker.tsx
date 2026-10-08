import { INDIAN_STATES } from '@avero/shared';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocateFixed } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import styles from './MapPicker.module.css';

/** What a dropped pin resolves to; only the fields the map could tell us are set. */
export interface PickedAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: (typeof INDIAN_STATES)[number];
  pincode?: string;
}

interface NominatimAddress {
  house_number?: string;
  building?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  quarter?: string;
  city?: string;
  town?: string;
  village?: string;
  city_district?: string;
  county?: string;
  state_district?: string;
  state?: string;
  postcode?: string;
}

// OpenStreetMap's public geocoder: fine for a demo at human pace (≤ 1 request/second, no bulk use).
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const INDIA: L.LatLngTuple = [22.6, 79.4];
// Leaflet positions the marker with `transform`, so the teardrop is rotated on an inner element.
const PIN_ICON = L.divIcon({
  className: styles.pin!,
  html: `<span class="${styles.pinShape!}"></span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 26], // rotated tip sits ≈ 15.5px below the centre
});

const squash = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
function toState(name: string | undefined): PickedAddress['state'] {
  if (!name) return undefined;
  if (/delhi/i.test(name)) return 'Delhi';
  return INDIAN_STATES.find((s) => squash(s) === squash(name));
}

function toPicked(a: NominatimAddress): PickedAddress {
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(', ') || undefined;
  const pincode = a.postcode?.replace(/\s/g, '');
  return {
    line1: join(a.house_number, a.building),
    line2: join(a.road, a.neighbourhood ?? a.suburb ?? a.quarter),
    city: a.city ?? a.town ?? a.village ?? a.city_district ?? a.county ?? a.state_district,
    state: toState(a.state),
    pincode: pincode && /^[1-9]\d{5}$/.test(pincode) ? pincode : undefined,
  };
}

const describe = (p: PickedAddress) => [p.line1, p.line2, p.city, p.state, p.pincode].filter(Boolean).join(', ');

/**
 * Drop or drag a pin on an OpenStreetMap map; the spot is reverse-geocoded into address fields
 * that the shopper confirms with "Use this location". Starts at `near` (e.g. the PIN code already
 * entered) when it can be found, else all of India.
 */
export function MapPicker({ near, onPick, onClose }: { near?: string; onPick: (a: PickedAddress) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const [picked, setPicked] = useState<PickedAddress | null>(null);
  const [status, setStatus] = useState<'idle' | 'looking' | 'error'>('idle');
  const [locating, setLocating] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);

  // Resolve the pin once it settles (debounced, so dragging doesn't spam the geocoder).
  const lookup = (at: L.LatLng) => {
    window.clearTimeout(timer.current);
    pending.current?.abort();
    setStatus('looking');
    timer.current = window.setTimeout(async () => {
      const ctrl = new AbortController();
      pending.current = ctrl;
      try {
        const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=en&lat=${at.lat}&lon=${at.lng}`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { address?: NominatimAddress };
        setPicked(body.address ? toPicked(body.address) : null);
        setStatus('idle');
      } catch {
        if (!ctrl.signal.aborted) setStatus('error');
      }
    }, 600);
  };

  const place = (at: L.LatLng, zoom?: number) => {
    const m = map.current;
    if (!m) return;
    if (!marker.current) {
      marker.current = L.marker(at, { icon: PIN_ICON, draggable: true, keyboard: true, title: 'Delivery location' }).addTo(m);
      marker.current.on('dragend', () => lookup(marker.current!.getLatLng()));
    } else marker.current.setLatLng(at);
    if (zoom) m.setView(at, zoom);
    lookup(at);
  };
  const onMapClick = useEffectEvent((at: L.LatLng) => place(at));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const m = L.map(el, { center: INDIA, zoom: 5, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => onMapClick(e.latlng));
    map.current = m;
    // Opened inside a dialog or an expanding panel: re-measure once the box has its final size.
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(el);

    const ctrl = new AbortController();
    if (near && near.trim()) {
      const q = /^[1-9]\d{5}$/.test(near.trim()) ? `postalcode=${near.trim()}` : `q=${encodeURIComponent(near)}`;
      fetch(`${NOMINATIM}/search?format=jsonv2&limit=1&countrycodes=in&${q}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ lat: string; lon: string }[]>) : []))
        .then((hits) => {
          if (hits[0]) m.setView([Number(hits[0].lat), Number(hits[0].lon)], 15);
        })
        .catch(() => undefined);
    }
    return () => {
      ctrl.abort();
      pending.current?.abort();
      window.clearTimeout(timer.current);
      resize.disconnect();
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, [near]);

  const locate = () => {
    if (!navigator.geolocation) return setStatus('error');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        place(L.latLng(pos.coords.latitude, pos.coords.longitude), 17);
      },
      () => {
        setLocating(false);
        setStatus('error');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <div className={styles.picker}>
      <div className={styles.toolbar}>
        <p className="meta">Tap the map to drop a pin, then drag it to your door.</p>
        <Button size="sm" variant="secondary" loading={locating} icon={<LocateFixed size={14} aria-hidden />} onClick={locate}>
          Use my location
        </Button>
      </div>
      <div ref={box} className={styles.map} role="application" aria-label="Map: choose your delivery location" />
      <p className={styles.result} aria-live="polite">
        {status === 'looking'
          ? 'Finding the address…'
          : status === 'error'
            ? 'We couldn’t look up that spot. Try again, or fill the address in below.'
            : picked
              ? describe(picked) || 'No street address here — try moving the pin.'
              : 'No location chosen yet.'}
      </p>
      <div className={styles.actions}>
        <Button size="sm" disabled={!picked || status !== 'idle'} onClick={() => picked && onPick(picked)}>
          Use this location
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close map
        </Button>
      </div>
    </div>
  );
}
