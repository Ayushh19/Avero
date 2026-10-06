import type { MeResponse, SessionUser, SignInInput, SignUpInput } from '@avero/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/ui/Overlay';
import { api } from '../../lib/api';

export const meQueryKey = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: ({ signal }) => api.get<MeResponse>('/auth/me', signal),
    staleTime: 60_000,
    select: (data) => data.user,
  });
}

export interface PublicConfig {
  auth: { googleEnabled: boolean };
  simulationTools: boolean;
  freeShippingThresholdPaise: number;
  returnWindowDays: number;
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get<PublicConfig>('/config', signal),
    staleTime: Infinity,
  });
}

interface SignInResponse {
  user: SessionUser;
  /** Guest bag lines folded into the account bag during sign-in. */
  mergedBagLines?: number;
}

function useSetUser() {
  const qc = useQueryClient();
  const toast = useToast();
  return ({ user, mergedBagLines }: SignInResponse) => {
    qc.setQueryData<MeResponse>(meQueryKey, { user });
    if (mergedBagLines) {
      toast.show(`We added ${mergedBagLines} ${mergedBagLines === 1 ? 'item' : 'items'} from this device to your bag`, { tone: 'success' });
    }
  };
}

export function useSignIn() {
  const setUser = useSetUser();
  return useMutation({
    mutationFn: (input: SignInInput) => api.post<SignInResponse>('/auth/signin', input),
    onSuccess: setUser,
  });
}

export function useSignUp() {
  const setUser = useSetUser();
  return useMutation({
    mutationFn: (input: SignUpInput) => api.post<SignInResponse>('/auth/signup', input),
    onSuccess: setUser,
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/signout'),
    onSuccess: () => {
      // Drop every cached user-specific resource.
      qc.clear();
      qc.setQueryData<MeResponse>(meQueryKey, { user: null });
    },
  });
}

/** `ref`: referral code from an invite link, kept through the Google round trip. */
export function googleSignInUrl(returnTo: string, ref?: string | null): string {
  return `/api/v1/auth/google/start?returnTo=${encodeURIComponent(returnTo)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
}
