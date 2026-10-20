import { Component, type ReactNode } from 'react';

/**
 * Catches a viewer that throws (a corrupt file, a timed-out read) and shows `fallback`
 * instead; the rest of the file screen keeps working. Nothing of the error is shown.
 */
export class ViewerBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
