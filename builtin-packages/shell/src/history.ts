export type CommandHistory = {
  push: (command: string) => void;
  navigate: (direction: number, currentLine: string) => string;
};

export function createCommandHistory(limit = 200): CommandHistory {
  let history: string[] = [];
  let cursor: number | null = null;
  let draft = "";

  return {
    push(command: string): void {
      const trimmed = String(command || "").trim();
      if (!trimmed) return;
      if (history[history.length - 1] !== trimmed) {
        history.push(trimmed);
      }
      if (history.length > limit) {
        history = history.slice(-limit);
      }
      cursor = null;
      draft = "";
    },
    navigate(direction: number, currentLine: string): string {
      if (history.length === 0) return currentLine;
      if (cursor === null) {
        draft = currentLine;
        cursor = history.length;
      }
      const nextIndex = cursor + direction;
      if (nextIndex < 0) {
        cursor = 0;
      } else if (nextIndex > history.length) {
        cursor = history.length;
      } else {
        cursor = nextIndex;
      }
      return cursor === history.length ? draft : (history[cursor] || "");
    },
  };
}
