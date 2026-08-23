import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';
import { afterEach, vi } from 'vitest';

class ResizeObserverStub implements ResizeObserver {
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
}

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
configure({ asyncUtilTimeout: 10_000 });

const computedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(window, 'getComputedStyle', {
  configurable: true,
  value: (element: Element) => computedStyle(element),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});
