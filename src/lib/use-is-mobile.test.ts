import { afterEach, describe, expect, it, vi } from 'vitest'
import { getIsMobileSnapshot, subscribeMobileMediaQuery } from './use-is-mobile'

describe('use-is-mobile media query store', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns true when media query matches mobile breakpoint (<768px)', () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('window', { matchMedia })

    expect(getIsMobileSnapshot()).toBe(true)
  })

  it('returns false when media query does not match', () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('window', { matchMedia })

    expect(getIsMobileSnapshot()).toBe(false)
  })

  it('returns false gracefully when window is undefined (SSR environment)', () => {
    // window is undefined by default in node environment
    expect(getIsMobileSnapshot()).toBe(false)
  })

  it('subscribes and unbinds change listeners cleanly', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()

    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener,
    }))
    vi.stubGlobal('window', { matchMedia })

    const cb = vi.fn()
    const unsubscribe = subscribeMobileMediaQuery(cb)
    expect(addEventListener).toHaveBeenCalledWith('change', cb)

    unsubscribe()
    expect(removeEventListener).toHaveBeenCalledWith('change', cb)
  })
})

