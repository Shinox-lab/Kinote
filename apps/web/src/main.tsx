import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { queryClient } from './lib/queryClient.js';
import { applyTheme, loadTheme, watchSystemTheme } from './lib/theme.js';
import { router } from './router.js';
import './index.css';

// The pre-paint script already set the theme; keep it in step with the OS while the choice is `system`.
applyTheme(loadTheme());
watchSystemTheme(() => applyTheme(loadTheme()));

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);
