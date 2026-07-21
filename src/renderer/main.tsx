import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsProvider } from './settings/SettingsProvider';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 未找到');

createRoot(container).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>,
);
