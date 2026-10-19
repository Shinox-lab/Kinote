import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../lib/api.js';
import { Button } from './ui.js';

/** What the user sees when a screen throws: a plain sentence and a way back, never the error itself. */
export function ErrorFallback({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-2 text-xl font-semibold">Something went wrong</h1>
      <p role="alert" className="mb-4 text-sm text-slate-700">
        {errorMessage(error)}
      </p>
      <Button onClick={onRetry ?? (() => window.location.reload())}>Try again</Button>
    </main>
  );
}

/** The app's last line of defence for render errors outside the router. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Detail for developers only; it is never rendered.
    console.error('console crashed', error, info.componentStack);
  }

  render() {
    return this.state.failed ? <ErrorFallback error={this.state.error} /> : this.props.children;
  }
}
