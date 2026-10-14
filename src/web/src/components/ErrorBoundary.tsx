import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-void flex items-center justify-center p-6">
          <div className="glass rounded-2xl p-8 max-w-md text-center">
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-ink-dim text-sm mb-4">
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-arcane text-void text-sm font-semibold rounded-lg px-6 py-2.5"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
