import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// Class component: React error boundaries can only be expressed as classes
// (there is no hook equivalent for componentDidCatch/getDerivedStateFromError).
// Catches render-time errors anywhere in the child tree so a single broken
// component does not blank the whole admin panel.
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface the error for browser/host error tooling without crashing.
    console.error("Edge Link UI error boundary caught:", error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      // Minimal fallback styled with the existing card/btn classes.
      return (
        <div className="card">
          <div className="card-header">
            <h2>Something went wrong</h2>
            <p>The configuration UI hit an unexpected error.</p>
          </div>
          <div className="card-content">
            <p>{error.message}</p>
            <button className="btn btn-primary" onClick={this.handleReload}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
