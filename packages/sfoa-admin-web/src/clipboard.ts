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
 * keeps working there. `execCommand` is used only as a last resort, and this
 * helper throws when nothing succeeds so callers can surface a clear message.
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
  document.body.appendChild(textarea);
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  if (previousRange && selection) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('Copy was rejected by the browser.');
  }
}
