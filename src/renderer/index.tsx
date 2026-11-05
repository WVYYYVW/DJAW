import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { store } from './store/store';

// For debugging from the developer tools.
(window as unknown as { djaw: unknown }).djaw = store;

window.addEventListener('error', e => console.error('[DJAW]', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => console.error('[DJAW]', e.reason));

createRoot(document.getElementById('root')!).render(<App />);
