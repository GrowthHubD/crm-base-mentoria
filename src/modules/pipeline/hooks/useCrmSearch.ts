'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuthScopeKey } from '@/modules/auth/client-scope';
import { crmScopeKey, currentUnitScope } from '@/modules/pipeline/crm-read-model';
import type { ConversationSearchResult } from '@/modules/pipeline/queries';

interface SearchState {
  key: string;
  results: ConversationSearchResult[];
}

export function useCrmSearch(activeConnection: string, rawTerm: string) {
  const userId = useAuthScopeKey();
  const unitId = currentUnitScope();
  const term = rawTerm.trim();
  const active = term.length >= 2;
  const scope = userId ? crmScopeKey(userId, unitId, activeConnection) : null;
  const queryKey = scope && active ? `${scope}\u0000${term.toLocaleLowerCase()}` : null;
  const [state, setState] = useState<SearchState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!queryKey) {
      setState(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timeout = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term });
        if (activeConnection === 'email') params.set('channel', 'email');
        else if (activeConnection !== 'all') params.set('connectionId', activeConnection);
        const headers = unitId !== 'all' ? { 'x-unit-id': unitId } : undefined;
        const response = await fetch(`/api/crm/search?${params.toString()}`, {
          cache: 'no-store',
          headers,
          signal: controller.signal,
        });
        const payload = response.ok
          ? (await response.json()) as { results?: ConversationSearchResult[] }
          : { results: [] };
        if (!controller.signal.aborted) setState({ key: queryKey, results: payload.results ?? [] });
      } catch {
        if (!controller.signal.aborted) setState({ key: queryKey, results: [] });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [activeConnection, queryKey, term, unitId]);

  return useMemo(() => ({
    active,
    loading: active && (loading || state?.key !== queryKey),
    results: state?.key === queryKey ? state.results : null,
  }), [active, loading, queryKey, state]);
}
