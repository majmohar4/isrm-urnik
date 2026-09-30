import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

if ('serviceWorker' in navigator) {
  let reloadingForUpdate = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
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
