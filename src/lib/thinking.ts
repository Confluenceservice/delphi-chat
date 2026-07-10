// MiniMax-M3 emits reasoning inline as <think>...</think> before the real answer.
// Strip completed blocks and hide any still-open trailing block until it closes.
export function stripThinking(raw: string): string {
  const withoutClosed = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const openIdx = withoutClosed.indexOf("<think>");
  const visible = openIdx === -1 ? withoutClosed : withoutClosed.slice(0, openIdx);
  return visible.trimStart();
}
