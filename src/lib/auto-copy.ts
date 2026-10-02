export function copyCompletedSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const text = selection.toString();
  if (!text.trim()) return;
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  if (element?.closest('textarea, input, [contenteditable], .xterm')) return;
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => {});
  else document.execCommand('copy');
}
