import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './router';
import { useAuth } from './stores/auth';
import { ErrorBoundary } from './components/ErrorBoundary';

function Boot() {
  const hydrate = useAuth((s) => s.hydrate);
  useEffect(() => {
    // Run in background; don't block UI if it fails/hangs
    const timeout = setTimeout(() => {
      useAuth.setState({ loading: false });
    }, 3000);
    hydrate().finally(() => clearTimeout(timeout));
  }, [hydrate]);
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Boot />
    </ErrorBoundary>
  </StrictMode>,
);
