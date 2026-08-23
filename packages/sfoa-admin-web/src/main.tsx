import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { createAdminQueryClient } from './query-client.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('SFoA Admin root element was not found.');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createAdminQueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
