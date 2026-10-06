import type { NotificationListDto, NotificationPreferenceDto } from '@avero/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useMe } from '../auth/hooks';

export const notificationsKey = ['notifications'] as const;

/** Signed-in only; refreshed every minute and on focus so the bell stays current. */
export function useNotifications() {
  const { data: user } = useMe();
  return useQuery({
    queryKey: notificationsKey,
    queryFn: ({ signal }) => api.get<NotificationListDto>('/notifications', signal),
    enabled: Boolean(user),
    refetchInterval: 60_000,
  });
}

/** Full history for the notifications page, 30 at a time ("Load more"). */
export function useNotificationPages() {
  const { data: user } = useMe();
  return useInfiniteQuery({
    queryKey: [...notificationsKey, 'pages'],
    queryFn: ({ pageParam, signal }) =>
      api.get<NotificationListDto>(`/notifications${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(user),
  });
}

/** Read state is safe to update optimistically (docs/PRODUCT.md). */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { ids: string[] } | { all: true }) => api.post<{ unreadCount: number }>('/notifications/read', target),
    onMutate: async (target) => {
      await qc.cancelQueries({ queryKey: notificationsKey });
      const now = new Date().toISOString();
      qc.setQueryData<NotificationListDto>(notificationsKey, (prev) => {
        if (!prev) return prev;
        const hit = (id: string) => 'all' in target || target.ids.includes(id);
        const notifications = prev.notifications.map((n) => (hit(n.id) && !n.readAt ? { ...n, readAt: now } : n));
        return { ...prev, notifications, unreadCount: 'all' in target ? 0 : Math.max(0, prev.unreadCount - notifications.filter((n, i) => n.readAt && !prev.notifications[i]!.readAt).length) };
      });
    },
    onSuccess: ({ unreadCount }) => {
      qc.setQueryData<NotificationListDto>(notificationsKey, (prev) => (prev ? { ...prev, unreadCount } : prev));
      void qc.invalidateQueries({ queryKey: [...notificationsKey, 'pages'] });
    },
    onError: () => qc.invalidateQueries({ queryKey: notificationsKey }),
  });
}

export function usePreferences() {
  return useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: ({ signal }) => api.get<{ preferences: NotificationPreferenceDto[] }>('/notifications/preferences', signal),
    select: (d) => d.preferences,
  });
}

export function useSetPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { kind: NotificationPreferenceDto['kind']; inApp: boolean; email: boolean }) =>
      api.put<{ preferences: NotificationPreferenceDto[] }>('/notifications/preferences', { preferences: [p] }),
    // Toggles are safe to show immediately; the server's answer (or a refetch on error) settles them.
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: ['notifications', 'preferences'] });
      qc.setQueryData<{ preferences: NotificationPreferenceDto[] }>(['notifications', 'preferences'], (prev) =>
        prev ? { preferences: prev.preferences.map((x) => (x.kind === p.kind ? { ...x, inApp: p.inApp, email: x.emailLocked ? true : p.email } : x)) } : prev,
      );
    },
    onSuccess: (d) => qc.setQueryData(['notifications', 'preferences'], d),
    onError: () => qc.invalidateQueries({ queryKey: ['notifications', 'preferences'] }),
  });
}

const rtf = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
export function timeAgo(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
