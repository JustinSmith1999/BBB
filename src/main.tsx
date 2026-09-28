import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { captureMetaClickIds } from './lib/metaClickIds';

// Persist the Meta ad-click id (fbclid -> _fbc) at first touch, before any
// routing, so it survives to checkout and Meta can attribute the purchase.
captureMetaClickIds();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
