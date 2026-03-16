'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      let errorMessage = "An unexpected error occurred.";
      let isFirestoreError = false;
      
      try {
        if (this.state.error?.message) {
          const parsed = JSON.parse(this.state.error.message);
          if (parsed.error && parsed.operationType) {
            isFirestoreError = true;
            if (parsed.error.includes('Missing or insufficient permissions')) {
              errorMessage = "You don't have permission to perform this action. Please check your access rights or sign in again.";
            } else {
              errorMessage = parsed.error;
            }
          }
        }
      } catch (e) {
        // Not a JSON error message, use default or the error message itself
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#f5f5f0] p-4">
          <div className="max-w-md w-full bg-white p-8 rounded-2xl shadow-lg border border-red-100 flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            </div>
            <h2 className="text-2xl font-serif font-semibold text-gray-900 mb-2">Oops! Something went wrong</h2>
            <p className="text-gray-600 mb-8">{errorMessage}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 bg-[#5A5A40] text-white rounded-full font-medium hover:bg-[#4a4a35] transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
