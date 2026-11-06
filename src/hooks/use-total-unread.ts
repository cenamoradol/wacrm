'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Conversation } from '@/types';

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  // Keep a live local mirror of {id → unread + archived} so INSERT/
  // UPDATE/DELETE events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, { unread: number; archived: boolean }>>(
    new Map()
  );

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Initial load. RLS scopes this to the signed-in user automatically —
    // no explicit user_id filter needed here.
    (async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('id, unread_count, archived');
      if (cancelled || error || !data) return;

      const map = new Map<string, { unread: number; archived: boolean }>();
      let sum = 0;
      for (const row of data as {
        id: string;
        unread_count: number;
        archived?: boolean;
      }[]) {
        const n = row.unread_count ?? 0;
        const archived = row.archived ?? false;
        map.set(row.id, { unread: n, archived });
        // Archived threads live outside the inbox — they don't nag.
        if (!archived && n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    })();

    const channel = supabase
      .channel('total-unread-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            map.set(row.id, {
              unread: row.unread_count ?? 0,
              archived: row.archived ?? false,
            });
          }
          // Recompute — cheap, conversations per user stay small.
          let sum = 0;
          for (const v of map.values()) {
            if (!v.archived && v.unread > 0) sum += 1;
          }
          setTotal(sum);
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return total;
}
