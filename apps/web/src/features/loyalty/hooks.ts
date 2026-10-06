import type { LoyaltyDto, ReferralCodeDto, ReferralDto } from '@avero/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function useLoyalty(enabled = true) {
  return useQuery({ queryKey: ['loyalty'], queryFn: ({ signal }) => api.get<LoyaltyDto>('/loyalty', signal), enabled });
}

export function useReferrals() {
  return useQuery({ queryKey: ['referrals'], queryFn: ({ signal }) => api.get<ReferralDto>('/referrals', signal) });
}

export function useReferralCode(code: string | undefined) {
  return useQuery({
    queryKey: ['referrals', 'code', code],
    queryFn: ({ signal }) => api.get<ReferralCodeDto>(`/referrals/${encodeURIComponent(code!)}`, signal),
    enabled: Boolean(code),
  });
}
