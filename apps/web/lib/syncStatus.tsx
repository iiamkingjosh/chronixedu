'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { getPendingCount, processOfflineQueues } from './offlineSync';

export type SyncState = 'online' | 'syncing' | 'offline';

interface SyncStatusContextValue {
  status: SyncState;
  pendingCount: number;
  /** Re-reads the pending count from IndexedDB — call after queueing a new offline entry. */
  refresh: () => void;
}

const SyncStatusContext = createContext<SyncStatusContextValue | null>(null);

const POLL_INTERVAL_MS = 30_000;

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const syncingRef = useRef(false);

  const refresh = useCallback(() => {
    getPendingCount().then(setPendingCount).catch(() => {});
  }, []);

  const sync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      await processOfflineQueues();
    } finally {
      setSyncing(false);
      syncingRef.current = false;
      refresh();
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(navigator.onLine);
    refresh();
    sync();

    function handleOnline() {
      setOnline(true);
      sync();
    }
    function handleOffline() {
      setOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    const interval = setInterval(() => {
      refresh();
      sync();
    }, POLL_INTERVAL_MS);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [refresh, sync]);

  const status: SyncState = !online ? 'offline' : syncing ? 'syncing' : 'online';

  return (
    <SyncStatusContext.Provider value={{ status, pendingCount, refresh }}>
      {children}
    </SyncStatusContext.Provider>
  );
}

export function useSyncStatus() {
  const ctx = useContext(SyncStatusContext);
  if (!ctx) throw new Error('useSyncStatus must be used within SyncStatusProvider');
  return ctx;
}
