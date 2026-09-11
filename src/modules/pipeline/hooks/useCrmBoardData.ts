'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthScopeKey } from '@/modules/auth/client-scope';
import {
  acceptsBoardResponse,
  boardSignature,
  crmQueuesRequestPath,
  crmScopeKey,
  currentUnitScope,
  mergeQueuesResponse,
  shouldRefreshConnections,
  type QueuesPollResponse,
  type QueuesResponse,
} from '@/modules/pipeline/crm-read-model';

const POLL_INTERVAL_MS = 4_000;

interface CachedBoard {
  data: QueuesResponse;
  signature: string;
  connectionsFetchedAt: number;
}

const boardCache = new Map<string, CachedBoard>();

interface Snapshot {
  key: string;
  data: QueuesResponse;
  signature: string;
}

interface Flight {
  key: string;
  controller: AbortController;
  promise: Promise<void>;
}

export function clearCrmBoardCache() {
  boardCache.clear();
}

export function useCrmBoardData(activeConnection: string) {
  const userId = useAuthScopeKey();
  const unitId = currentUnitScope();
  const scopeKey = userId ? crmScopeKey(userId, unitId, activeConnection) : null;
  const cached = scopeKey ? boardCache.get(scopeKey) : undefined;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() =>
    scopeKey && cached
      ? { key: scopeKey, data: cached.data, signature: cached.signature }
      : null
  );
  const [loading, setLoading] = useState(!cached);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeKeyRef = useRef(scopeKey);
  const requestSequence = useRef(0);
  const flightRef = useRef<Flight | null>(null);

  activeKeyRef.current = scopeKey;

  const load = useCallback(async (options: {
    indicator?: boolean;
    replace?: boolean;
    includeConnections?: boolean;
  } = {}) => {
    if (!scopeKey) return;

    const existing = flightRef.current;
    if (existing?.key === scopeKey && !options.replace) return existing.promise;
    if (existing) existing.controller.abort();

    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    const cachedBeforeRequest = boardCache.get(scopeKey);
    const includeConnections = options.includeConnections
      ?? shouldRefreshConnections(cachedBeforeRequest?.connectionsFetchedAt);
    if (options.indicator) setRefreshing(true);
    else if (!boardCache.has(scopeKey)) setLoading(true);

    const promise = (async () => {
      try {
        const headers = unitId !== 'all' ? { 'x-unit-id': unitId } : undefined;
        const response = await fetch(crmQueuesRequestPath(activeConnection, includeConnections), {
          cache: 'no-store',
          headers,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const incoming = (await response.json()) as QueuesPollResponse;

        if (!acceptsBoardResponse(activeKeyRef.current, scopeKey, requestSequence.current, sequence)) return;
        const latestCached = boardCache.get(scopeKey);
        const data = mergeQueuesResponse(latestCached?.data, incoming);
        if (!data) throw new Error('Resposta parcial recebida sem snapshot completo');
        const signature = boardSignature(data);

        boardCache.set(scopeKey, {
          data,
          signature,
          connectionsFetchedAt: incoming.connections
            ? Date.now()
            : latestCached?.connectionsFetchedAt ?? 0,
        });
        setSnapshot((previous) =>
          previous?.key === scopeKey && previous.signature === signature
            ? previous
            : { key: scopeKey, data, signature }
        );
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        if (!acceptsBoardResponse(activeKeyRef.current, scopeKey, requestSequence.current, sequence)) return;
        setError(loadError instanceof Error ? loadError.message : 'Erro carregando dados');
      } finally {
        if (flightRef.current?.controller === controller) flightRef.current = null;
        if (acceptsBoardResponse(activeKeyRef.current, scopeKey, requestSequence.current, sequence)) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    flightRef.current = { key: scopeKey, controller, promise };
    return promise;
  }, [activeConnection, scopeKey, unitId]);

  useEffect(() => {
    requestSequence.current += 1;
    flightRef.current?.controller.abort();
    flightRef.current = null;

    if (!scopeKey) {
      setSnapshot(null);
      setLoading(true);
      return;
    }

    const fromCache = boardCache.get(scopeKey);
    setSnapshot(fromCache ? { key: scopeKey, data: fromCache.data, signature: fromCache.signature } : null);
    setLoading(!fromCache);
    setError(null);
    void load();

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') void load();
      }, POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else {
        stop();
        flightRef.current?.controller.abort();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      flightRef.current?.controller.abort();
    };
  }, [load, scopeKey]);

  const beginMutation = useCallback(() => {
    requestSequence.current += 1;
    flightRef.current?.controller.abort();
    flightRef.current = null;
  }, []);

  const setData = useCallback((update: (current: QueuesResponse) => QueuesResponse) => {
    if (!scopeKey) return;
    setSnapshot((previous) => {
      if (!previous || previous.key !== scopeKey) return previous;
      const data = update(previous.data);
      const signature = boardSignature(data);
      const connectionsFetchedAt = boardCache.get(scopeKey)?.connectionsFetchedAt ?? 0;
      boardCache.set(scopeKey, { data, signature, connectionsFetchedAt });
      return { key: scopeKey, data, signature };
    });
  }, [scopeKey]);

  const data = scopeKey && snapshot?.key === scopeKey ? snapshot.data : null;

  return {
    data,
    loading: !scopeKey || loading || (snapshot !== null && snapshot.key !== scopeKey),
    refreshing,
    error,
    setData,
    beginMutation,
    reload: (indicator = true) => load({
      indicator,
      replace: true,
      includeConnections: true,
    }),
  };
}
