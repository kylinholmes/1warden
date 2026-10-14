import { useEffect, useRef } from 'react';
import type { ApplicationClient } from '../application/types';

/** Invalidates asynchronous file/crypto results at every session boundary. */
export function useTransferLifetime(client: ApplicationClient) {
  const request = useRef(0);
  useEffect(() => {
    const initial = client.getSnapshot();
    const stop = client.subscribe(() => {
      const current = client.getSnapshot();
      if (current.status !== 'unlocked' || current.account?.email !== initial.account?.email
        || current.account?.serverUrl !== initial.account?.serverUrl) request.current++;
    });
    return () => { request.current++; stop(); };
  }, [client]);
  return request;
}
