import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

if ('serviceWorker' in navigator) {
  let reloadingForUpdate = false;
  // On a first visit no worker controls the page yet: the new worker claiming it is not an update, the page is
  // already current, so it must not reload or announce "updated" (that covered the install button for new visitors).
  const wasControlled = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate || !wasControlled) return;
    reloadingForUpdate = true;
    window.sessionStorage.setItem('isrm-pwa-updated', '1');
    window.location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'ISRM_UPDATED' || reloadingForUpdate || !wasControlled) return;
    reloadingForUpdate = true;
    window.sessionStorage.setItem('isrm-pwa-updated', '1');
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      const checkForUpdate = () => registration.update().catch(() => undefined);
      checkForUpdate();
      window.setInterval(checkForUpdate, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  });
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
