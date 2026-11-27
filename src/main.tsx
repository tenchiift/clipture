import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { QuickDrawer } from './components/QuickDrawer.tsx';
import { initDesktopBridge } from './lib/desktop-bridge';

const isDrawerView =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('view') === 'drawer';

void initDesktopBridge().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {isDrawerView ? <QuickDrawer /> : <App />}
    </StrictMode>,
  );
});
