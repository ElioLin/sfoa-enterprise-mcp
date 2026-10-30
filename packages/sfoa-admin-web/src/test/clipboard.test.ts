import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../clipboard';

describe('copyTextToClipboard clipboard resilience', () => {
  const nativeClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const nativeExec = Object.getOwnPropertyDescriptor(document, 'execCommand');

  afterEach(() => {
    if (nativeClipboard) Object.defineProperty(navigator, 'clipboard', nativeClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    if (nativeExec) Object.defineProperty(document, 'execCommand', nativeExec);
    else delete (document as { execCommand?: unknown }).execCommand;
    document.body.removeAttribute('tabindex');
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('uses the async Clipboard API when it is available and never falls back', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec, writable: true });

    await expect(copyTextToClipboard('alpha')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(exec).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe('');
  });

  it('falls back to execCommand copy when the Clipboard API is absent (plain HTTP context)', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec, writable: true });

    await expect(copyTextToClipboard('beta')).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith('copy');
    // the temporary textarea is removed again
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.body.textContent).toBe('');
  });

  it('falls back when the Clipboard API rejects a write', async () => {
    const writeText = vi.fn<() => Promise<void>>(async () => {
      throw new Error('Denied');
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec, writable: true });

    await expect(copyTextToClipboard('gamma')).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('throws when every copy path fails', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec, writable: true });

    await expect(copyTextToClipboard('delta')).rejects.toThrow();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('moves the scratch textarea inside a focus trap instead of copying nothing', async () => {
    // Ant Design Drawer/Modal run a focus trap (rc-util useLockFocus): focusing
    // anything outside the panel is undone immediately. With the textarea left
    // in <body>, execCommand('copy') then reports true while copying nothing.
    delete (navigator as { clipboard?: unknown }).clipboard;
    const panel = document.createElement('div');
    const trapButton = document.createElement('button');
    panel.appendChild(trapButton);
    document.body.appendChild(panel);
    trapButton.focus();
    const keepFocusInside = (): void => {
      if (!panel.contains(document.activeElement)) trapButton.focus();
    };
    window.addEventListener('focusin', keepFocusInside);
    const exec = vi.fn(() => {
      const focused = document.activeElement;
      return focused instanceof HTMLTextAreaElement
        && panel.contains(focused)
        && focused.value === 'epsilon';
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec, writable: true });

    await expect(copyTextToClipboard('epsilon')).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(panel.querySelector('textarea')).toBeNull();
    window.removeEventListener('focusin', keepFocusInside);
  });

  it('never reports success when focus cannot be kept on the scratch textarea', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    const stealToBody = (): void => {
      document.body.tabIndex = -1;
      document.body.focus();
    };
    window.addEventListener('focusin', stealToBody);
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec, writable: true });

    await expect(copyTextToClipboard('zeta')).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
    window.removeEventListener('focusin', stealToBody);
  });
});
