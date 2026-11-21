import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppShell } from './app/AppShell';
import { GitHubCallbackPage } from './components/GitHubCallbackPage';
import './styles/forge.css';

/* Bridge OAuth callback beží na samostatnej stránke /github/callback. */
const isGitHubCallback = window.location.pathname === '/github/callback';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isGitHubCallback ? <GitHubCallbackPage /> : <AppShell />}
  </React.StrictMode>,
);
