import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Global error boundary to prevent blank white screens.
 * Catches any React rendering errors and displays a helpful message.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '2rem',
          backgroundColor: '#1a1a2e',
          color: '#e0e0e0',
          fontFamily: 'system-ui, -apple-system, sans-serif'
        }}>
          <div style={{
            maxWidth: '600px',
            textAlign: 'center'
          }}>
            <h1 style={{
              color: '#ff6b6b',
              marginBottom: '1rem',
              fontSize: '1.5rem'
            }}>
              Oops! Something went wrong
            </h1>

            <p style={{
              marginBottom: '1.5rem',
              color: '#a0a0a0',
              lineHeight: '1.6'
            }}>
              The UI encountered an error while rendering. This prevents a blank white screen.
              You can try reloading or resetting the view.
            </p>

            <div style={{
              display: 'flex',
              gap: '1rem',
              justifyContent: 'center',
              marginBottom: '2rem'
            }}>
              <button
                onClick={this.handleReload}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: '#4a90d9',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: 500
                }}
              >
                Reload Page
              </button>
              <button
                onClick={this.handleReset}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'transparent',
                  color: '#4a90d9',
                  border: '1px solid #4a90d9',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: 500
                }}
              >
                Try Again
              </button>
            </div>

            {this.state.error && (
              <details style={{
                textAlign: 'left',
                backgroundColor: '#2a2a3e',
                padding: '1rem',
                borderRadius: '8px',
                marginTop: '1rem'
              }}>
                <summary style={{
                  cursor: 'pointer',
                  color: '#ff6b6b',
                  marginBottom: '0.5rem'
                }}>
                  Error Details (for debugging)
                </summary>
                <pre style={{
                  overflow: 'auto',
                  fontSize: '0.75rem',
                  color: '#ffcc00',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}>
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            <p style={{
              marginTop: '2rem',
              fontSize: '0.8rem',
              color: '#666'
            }}>
              If this keeps happening, please report the issue.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
