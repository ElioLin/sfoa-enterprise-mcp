/**
 * Copies `value` to the clipboard, preferring the modern async Clipboard API and
 * falling back to a hidden-textarea selection + `document.execCommand('copy')`
 * when that API is unavailable or rejected.
 *
 * The async `navigator.clipboard.writeText` is only exposed in *secure
 * contexts* (HTTPS, or http://localhost / 127.0.0.1). The SFoA Admin is often
 * served over plain HTTP on a LAN host (for example http://192.168.156.203),
 * where `navigator.clipboard` is missing or rejects every write. The legacy
 * path needs only a user activation (the click already provides one), so copy
 * keeps working there.
 *
 * Modal components (Ant Design Drawer/Modal) install a focus trap that pulls
 * focus back into their panel as soon as anything else is focused. With the
 * textarea appended to `<body>`, the trap steals focus, `execCommand('copy')`
 * then copies the (empty) page selection but still reports success, and the
 * clipboard keeps its old content — a silent "copied" failure. When focus is
 * stolen the textarea is therefore moved inside the container that stole it and
 * the copy is retried; nothing is reported as copied unless the textarea really
 * holds focus while `execCommand` runs.
 */
export async function copyTextToClipboard(value: string): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return;
    } catch {
      // Rejected (e.g. a permissions policy) -> try the legacy path below.
    }
  }
  if (typeof document === 'undefined') {
    throw new Error('Clipboard is unavailable in this environment.');
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  // Keep it out of the layout so focusing/selecting it does not scroll or
  // visibly replace the page content.
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  let host: HTMLElement = document.body;
  host.appendChild(textarea);
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  // Focus the scratch textarea. A focus trap refuses focus outside its panel
  // (moving it back to one of its own elements), so retry from inside the
  // container that keeps stealing it.
  let focused = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    textarea.focus({ preventScroll: true });
    if (document.activeElement === textarea) {
      focused = true;
      break;
    }
    const thief = document.activeElement;
    const nextHost = thief instanceof HTMLElement && thief !== document.body ? thief.parentElement : null;
    if (!nextHost || nextHost === host) break;
    host = nextHost;
    host.appendChild(textarea);
  }

  let copied = false;
  if (focused) {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      copied = document.activeElement === textarea && document.execCommand('copy');
    } catch {
      copied = false;
    }
  }
  if (previousRange && selection) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  textarea.remove();
  if (!copied) {
    throw new Error('Copy was rejected by the browser.');
  }
}
