import React from 'react';
import { createRoot } from 'react-dom/client';

import '@blocknote/core/style.css';
import '@blocknote/react/style.css';
import '@blocknote/mantine/style.css';
import './index.css';

import { App } from './App';

const root = createRoot(document.getElementById('root')!);
// NOTE: StrictMode stays OFF: its dev double-mount creates and immediately
// destroys the Hocuspocus provider/websocket pair, and the surviving instance
// ends up limbo (no sync frames). We can re-enable once the provider lifecycle
// is double-mount-safe (e.g., a singleton provider per pageId).
root.render(<App />);
