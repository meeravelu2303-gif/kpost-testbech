import { scanA11y, formatViolations } from '../../utils/a11y';
import { SCREEN_BUDGETS, type ScreenValidator } from '../types';

/**
 * Opens the screen and starts the console/network listeners every later stage reads.
 *
 * Listeners attach BEFORE navigation: errors thrown during the initial render are the ones that
 * matter most, and a listener attached afterwards misses them entirely.
 */
export const navigationValidator: ScreenValidator = {
  stage: 'navigation',
  appliesTo: () => true,

  async run(context) {
    const { page, screen, baseURL } = context;

    page.on('console', (message) => {
      if (message.type() === 'error') context.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => context.consoleErrors.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) =>
      context.failedRequests.push(
        `${request.method()} ${request.url()} - ${request.failure()?.errorText ?? 'failed'}`
      )
    );
    page.on('response', (response) => {
      if (response.status() >= 400) {
        context.failedRequests.push(
          `${response.status()} ${response.request().method()} ${response.url()}`
        );
      }
    });

    const startedAt = Date.now();
    const response = await page.goto(new URL(screen.path, baseURL).toString(), {
      waitUntil: 'domcontentloaded',
    });
    /*
     * No networkidle wait. This app long-polls so it never reaches that state, and the lint rule
     * forbids it for exactly that reason. The `rendering` stage waits on the screen's declared
     * elements, which is the real readiness signal — and `loadMs` is measured to navigation
     * rather than to an arbitrary network lull.
     */
    context.loadMs = Date.now() - startedAt;

    if (response && response.status() >= 400) {
      return { outcome: 'failed', detail: `the screen returned HTTP ${response.status()}` };
    }
    return { outcome: 'passed' };
  },
};

/**
 * The screen actually rendered.
 *
 * `requiredElements` is mandatory in the type deliberately: a "screen loads" check that asserts
 * nothing about content passes against a blank page — the UI equivalent of a 404 satisfying
 * "must not be 2xx".
 */
export const renderingValidator: ScreenValidator = {
  stage: 'rendering',
  appliesTo: () => true,

  async run({ page, screen }) {
    const missing: string[] = [];
    for (const selector of screen.requiredElements) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 10_000 })
        .catch(() => false);
      if (!visible) missing.push(selector);
    }

    const present: string[] = [];
    for (const selector of screen.forbiddenElements ?? []) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      if (visible) present.push(selector);
    }

    if (missing.length || present.length) {
      return {
        outcome: 'failed',
        detail: [
          missing.length ? `required element(s) absent: ${missing.join(', ')}` : '',
          present.length ? `forbidden element(s) present: ${present.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      };
    }
    return { outcome: 'passed' };
  },
};

export const consoleValidator: ScreenValidator = {
  stage: 'console',
  appliesTo: () => true,

  async run({ consoleErrors }) {
    return consoleErrors.length
      ? {
          outcome: 'failed',
          detail: `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(' | ').slice(0, 300)}`,
        }
      : { outcome: 'passed' };
  },
};

export const networkValidator: ScreenValidator = {
  stage: 'network',
  appliesTo: () => true,

  async run({ failedRequests }) {
    return failedRequests.length
      ? {
          outcome: 'failed',
          detail: `${failedRequests.length} failed request(s): ${failedRequests.slice(0, 3).join(' | ').slice(0, 300)}`,
        }
      : { outcome: 'passed' };
  },
};

/** WCAG 2.1 A/AA via the existing axe helper. A violation is an APP defect, never a rule to widen. */
export const accessibilityValidator: ScreenValidator = {
  stage: 'accessibility',
  appliesTo: () => true,

  async run({ page, screen }) {
    const violations = await scanA11y(page, {
      include: screen.a11yScope,
      disableRules: Object.keys(screen.a11yDisableRules ?? {}),
    });
    return violations.length
      ? { outcome: 'failed', detail: formatViolations(violations, screen.name).slice(0, 400) }
      : { outcome: 'passed' };
  },
};

export const performanceValidator: ScreenValidator = {
  stage: 'performance',
  appliesTo: () => true,

  async run({ screen, loadMs }) {
    const budget =
      typeof screen.budget === 'number' ? screen.budget : SCREEN_BUDGETS[screen.budget ?? 'standard'];
    const elapsed = loadMs ?? 0;
    return elapsed > budget
      ? { outcome: 'failed', detail: `${elapsed}ms against a ${budget}ms budget` }
      : { outcome: 'passed', detail: `${elapsed}ms / ${budget}ms` };
  },
};

/** Re-renders at phone width and re-checks required elements — catches layout that collapses. */
export const responsiveValidator: ScreenValidator = {
  stage: 'responsive',
  appliesTo: () => true,

  async run({ page, screen }) {
    const widths = screen.responsiveWidths ?? [390];
    const original = page.viewportSize();

    try {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 844 });

        const missing: string[] = [];
        for (const selector of screen.requiredElements) {
          const visible = await page
            .locator(selector)
            .first()
            .isVisible({ timeout: 5_000 })
            .catch(() => false);
          if (!visible) missing.push(selector);
        }
        if (missing.length) {
          return { outcome: 'failed', detail: `at ${width}px, absent: ${missing.join(', ')}` };
        }

        // A horizontal scrollbar at phone width is a layout defect, not a preference.
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        );
        if (overflows) {
          return { outcome: 'failed', detail: `the page scrolls horizontally at ${width}px` };
        }
      }
      return { outcome: 'passed' };
    } finally {
      if (original) await page.setViewportSize(original);
    }
  },
};
