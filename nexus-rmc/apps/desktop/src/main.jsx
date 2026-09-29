import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, useUi } from './stores/ui.js';
import { platform } from './services/platform.js';
import './styles/index.css';

// Apply the theme before the first paint so there is no flash.
applyTheme(useUi.getState().theme);
if (platform.isDesktop) document.documentElement.dataset.desktop = '';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
