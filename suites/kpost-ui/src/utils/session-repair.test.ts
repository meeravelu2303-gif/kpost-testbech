import { describe, expect, it } from 'vitest';
import { SESSION_LOST_MARKER, looksLikeLostSession } from './session-repair';

/**
 * The detector that decides whether a failed test lost the shared session.
 *
 * Worth its own tests because it fails SILENTLY when it is wrong: a pattern that
 * never matches turns the repair into a no-op, the cascade comes back, and
 * nothing in the output says the safety net was the thing that broke. The ANSI
 * case below is exactly that — Playwright colourises assertion messages, so the
 * first version of this matched nothing at all against a real failure.
 */
const ESC = '';

describe('looksLikeLostSession', () => {
  it('recognises the explicit marker waitForAppReady raises', () => {
    expect(looksLikeLostSession([{ message: `Error: ${SESSION_LOST_MARKER} — landed on /login.` }])).toBe(
      true,
    );
  });

  it('recognises a toHaveURL assertion that received /login', () => {
    expect(
      looksLikeLostSession([
        { message: 'expect(page).toHaveURL failed\nReceived string:  "http://localhost:3000/login"' },
      ]),
    ).toBe(true);
  });

  it('still recognises it through Playwright’s ANSI colouring', () => {
    expect(
      looksLikeLostSession([
        {
          message:
            `expect(page).toHaveURL failed\nReceived string:  ${ESC}[31m"http://localhost:3000/login"${ESC}[39m`,
        },
      ]),
    ).toBe(true);
  });

  it('finds it among several errors, not only the first', () => {
    expect(
      looksLikeLostSession([
        { message: 'some unrelated timeout' },
        { message: `Error: ${SESSION_LOST_MARKER}` },
      ]),
    ).toBe(true);
  });

  it('does not fire on an ordinary failure', () => {
    expect(
      looksLikeLostSession([
        { message: 'expect(locator).toBeVisible() failed\nLocator: getByRole("button")' },
      ]),
    ).toBe(false);
  });

  it('does not fire on a test that merely mentions the login page', () => {
    expect(
      looksLikeLostSession([{ message: 'Expected pattern: /\\/login/i\nReceived string:  "/home"' }]),
    ).toBe(false);
  });

  it('handles an empty error list and messageless errors', () => {
    expect(looksLikeLostSession([])).toBe(false);
    expect(looksLikeLostSession([{}])).toBe(false);
  });
});
