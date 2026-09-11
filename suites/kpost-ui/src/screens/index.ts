import type { ScreenDefinition } from '../engine';

/**
 * Every screen the engine drives — declarations only.
 *
 * To add one: append a declaration. It then receives the full pipeline — navigation, rendering,
 * console errors, failed requests, WCAG scan, load budget, responsive layout and (for
 * authenticated screens) the unguarded-route check. No validation code is written per screen.
 *
 * Selectors are role-based on purpose: they survive markup changes and they fail loudly when an
 * accessible name disappears, which is itself a defect worth catching.
 */
export const ALL_SCREENS: ScreenDefinition[] = [
  {
    id: 'login',
    name: 'Login',
    path: '/login',
    auth: 'anonymous',
    requiredElements: [
      'role=heading[name=/sign in to your account/i]',
      'role=textbox[name="Enter KPOST ID / Mobile number"]',
    ],
    budget: 'light',
    skip: {
      // The login screen has no session to lose; the guarded-route check does not apply.
      session: 'anonymous screen — there is no session to clear',
      journey: 'the sign-in flow is covered by tests/auth/login-form.spec.ts',
    },
  },

  {
    id: 'home',
    name: 'Home',
    path: '/home',
    auth: 'authenticated',
    requiredElements: ['role=searchbox[name=/search/i]'],
    // A crash shell renders without the rail; catching it here is cheaper than in every journey.
    forbiddenElements: ['text=/something went wrong/i'],
    budget: 'standard',
    skip: {
      journey: 'module navigation is covered by tests/home/',
    },
  },
];
