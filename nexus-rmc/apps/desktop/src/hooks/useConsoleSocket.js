import { useEffect } from 'react';
import { createConsoleSocket } from '../services/socket.js';
import { useAuth } from '../stores/auth.js';
import { useNetwork } from '../stores/network.js';

/** Opens the console socket while signed in; closes it on logout. */
export function useConsoleSocket() {
  const token = useAuth((s) => s.token);
  const serverUrl = useAuth((s) => s.serverUrl);

  useEffect(() => {
    if (!token || !serverUrl) return undefined;
    const { setStatus, pushRtt, handleMessage, reset } = useNetwork.getState();
    const sock = createConsoleSocket({
      serverUrl,
      token,
      onStatus: setStatus,
      onRtt: pushRtt,
      onMessage: handleMessage,
      onUnauthorized: () => useAuth.getState().expire(),
    });
    return () => {
      sock.close();
      reset();
    };
  }, [token, serverUrl]);
}
