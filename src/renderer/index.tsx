import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { store } from './store/store';
import './store/automix';
import './store/simplify';
import './store/profiles';
import './store/video';
import './store/stems';
import './store/libraryFolders';
import './store/sampler';
import './store/loops';
import './store/layers';

// For debugging from the developer tools.
(window as unknown as { djaw: unknown }).djaw = store;

window.addEventListener('error', e => console.error('[DJAW]', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => console.error('[DJAW]', e.reason));

createRoot(document.getElementById('root')!).render(<App />);
