import { createRoot } from "react-dom/client";
import { App } from "./App";

export function mountReactApp(mountNode: HTMLElement) {
  const root = createRoot(mountNode);
  root.render(<App />);
}
