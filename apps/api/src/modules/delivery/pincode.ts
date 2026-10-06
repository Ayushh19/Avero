import type { DeliveryEstimateDto } from '@avero/shared';
import { business } from '../../config/business';

/**
 * Simulated serviceability. Indian PIN codes encode the postal region in their leading digits,
 * so state lookup is real; serviceability and express coverage are AVERO's simulated network.
 */
const STATE_BY_PREFIX: [string, string][] = [
  ['11', 'Delhi'], ['12', 'Haryana'], ['13', 'Haryana'], ['14', 'Punjab'], ['15', 'Punjab'], ['16', 'Chandigarh'],
  ['17', 'Himachal Pradesh'], ['18', 'Jammu & Kashmir'], ['19', 'Jammu & Kashmir'],
  ['20', 'Uttar Pradesh'], ['21', 'Uttar Pradesh'], ['22', 'Uttar Pradesh'], ['23', 'Uttar Pradesh'],
  ['24', 'Uttarakhand'], ['25', 'Uttar Pradesh'], ['26', 'Uttarakhand'], ['27', 'Uttar Pradesh'], ['28', 'Uttar Pradesh'],
  ['30', 'Rajasthan'], ['31', 'Rajasthan'], ['32', 'Rajasthan'], ['33', 'Rajasthan'], ['34', 'Rajasthan'],
  ['36', 'Gujarat'], ['37', 'Gujarat'], ['38', 'Gujarat'], ['39', 'Gujarat'],
  ['40', 'Maharashtra'], ['41', 'Maharashtra'], ['42', 'Maharashtra'], ['43', 'Maharashtra'], ['44', 'Maharashtra'],
  ['45', 'Madhya Pradesh'], ['46', 'Madhya Pradesh'], ['47', 'Madhya Pradesh'], ['48', 'Madhya Pradesh'], ['49', 'Chhattisgarh'],
  ['50', 'Telangana'], ['51', 'Andhra Pradesh'], ['52', 'Andhra Pradesh'], ['53', 'Andhra Pradesh'],
  ['56', 'Karnataka'], ['57', 'Karnataka'], ['58', 'Karnataka'], ['59', 'Karnataka'],
  ['60', 'Tamil Nadu'], ['61', 'Tamil Nadu'], ['62', 'Tamil Nadu'], ['63', 'Tamil Nadu'], ['64', 'Tamil Nadu'],
  ['67', 'Kerala'], ['68', 'Kerala'], ['69', 'Kerala'],
  ['70', 'West Bengal'], ['71', 'West Bengal'], ['72', 'West Bengal'], ['73', 'West Bengal'], ['74', 'West Bengal'],
  ['75', 'Odisha'], ['76', 'Odisha'], ['77', 'Odisha'], ['78', 'Assam'], ['79', 'North East'],
  ['80', 'Bihar'], ['81', 'Bihar'], ['82', 'Jharkhand'], ['83', 'Jharkhand'], ['84', 'Bihar'], ['85', 'Bihar'],
];

const METROS: [string, string, string][] = [
  ['110', 'New Delhi', 'Delhi'],
  ['400', 'Mumbai', 'Maharashtra'],
  ['411', 'Pune', 'Maharashtra'],
  ['560', 'Bengaluru', 'Karnataka'],
  ['600', 'Chennai', 'Tamil Nadu'],
  ['500', 'Hyderabad', 'Telangana'],
  ['700', 'Kolkata', 'West Bengal'],
  ['380', 'Ahmedabad', 'Gujarat'],
];

/** Areas the simulated courier network doesn't reach (exercise the "unserviceable" path). */
const UNSERVICEABLE_PREFIXES = ['744', '6825', '9'];

export interface PincodeInfo {
  pincode: string;
  valid: boolean;
  serviceable: boolean;
  express: boolean;
  city: string | null;
  state: string | null;
}

export function lookupPincode(raw: string): PincodeInfo {
  const pincode = raw.replace(/\s/g, '');
  const valid = /^[1-9]\d{5}$/.test(pincode);
  const metro = METROS.find(([p]) => pincode.startsWith(p));
  const state = metro?.[2] ?? STATE_BY_PREFIX.find(([p]) => pincode.startsWith(p))?.[1] ?? null;
  const serviceable = valid && state !== null && !UNSERVICEABLE_PREFIXES.some((p) => pincode.startsWith(p));
  return { pincode, valid, serviceable, express: serviceable && Boolean(metro), city: metro?.[1] ?? null, state };
}

const IST_OFFSET_MS = 330 * 60_000;
const DISPATCH_CUTOFF_HOUR_IST = 14;

/** Adds business days (Mon–Sat; courier doesn't deliver on Sundays) in IST. */
function addDeliveryDays(fromIst: Date, days: number): Date {
  const d = new Date(fromIst);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0) added++;
  }
  return d;
}

const toIsoDate = (istDate: Date) => istDate.toISOString().slice(0, 10);

export function estimateDelivery(pincode: string, now: Date): DeliveryEstimateDto {
  const info = lookupPincode(pincode);
  const base: DeliveryEstimateDto = {
    pincode: info.pincode,
    serviceable: info.serviceable,
    city: info.city,
    state: info.state,
    options: [],
    message: '',
  };
  if (!info.valid) return { ...base, message: 'Enter a valid 6-digit PIN code.' };
  if (!info.serviceable) return { ...base, message: "Sorry, we don't deliver to this PIN code yet." };

  // Work in IST; orders after the cut-off dispatch the next day.
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const start = ist.getUTCHours() >= DISPATCH_CUTOFF_HOUR_IST ? addDeliveryDays(ist, 1) : ist;
  const { standard, express } = business.shipping;
  const options: DeliveryEstimateDto['options'] = [
    {
      method: 'standard',
      label: 'Standard delivery',
      feePaise: business.freeShippingThresholdPaise === 0 ? 0 : standard.feePaise,
      freeAbovePaise: business.freeShippingThresholdPaise,
      earliest: toIsoDate(addDeliveryDays(start, standard.minDays)),
      latest: toIsoDate(addDeliveryDays(start, standard.maxDays)),
    },
  ];
  if (info.express) {
    options.push({
      method: 'express',
      label: 'Express delivery',
      feePaise: express.feePaise,
      freeAbovePaise: Number.MAX_SAFE_INTEGER,
      earliest: toIsoDate(addDeliveryDays(start, express.minDays)),
      latest: toIsoDate(addDeliveryDays(start, express.maxDays)),
    });
  }
  const where = info.city ?? info.state;
  return { ...base, options, message: `Delivering to ${info.pincode}${where ? `, ${where}` : ''}` };
}
