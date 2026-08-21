import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Without this a single render throw unmounts the whole tree and leaves a white screen — on a
 * phone, with no console to look at, and no way back but force-quitting the app. Nothing here
 * touches the database: whatever went wrong, the messages and keys on the device are still fine,
 * and a reload is almost always enough.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("kin-render-error", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="crash">
      <b>🫠</b>
      <strong>Kin got tangled up</strong>
      <small>Nothing was lost — your messages are still safely on this device. A restart usually sorts it out.</small>
      <button className="crash-retry" onClick={() => location.reload()}>Restart Kin</button>
      <details><summary>What happened</summary><pre>{error.message || String(error)}</pre></details>
    </div>;
  }
}
