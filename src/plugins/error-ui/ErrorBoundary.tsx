import {Component, type ErrorInfo, type ReactNode} from "react";
import {ErrorView} from "./ErrorView";

type ErrorBoundaryState = {
    readonly hasError: boolean;
};

/** A stable page-level boundary that replaces only its own failed subtree. */
export class ErrorBoundary extends Component<{readonly children?: ReactNode; readonly fallback?: ReactNode}, ErrorBoundaryState> {
    state: ErrorBoundaryState = {hasError: false};

    static getDerivedStateFromError(): ErrorBoundaryState {
        return {hasError: true};
    }

    componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
        console.error("UI page rendering failed.", {error, errorInfo});
    }

    render() {
        return this.state.hasError ? this.props.fallback ?? <ErrorView/> : this.props.children;
    }
}
