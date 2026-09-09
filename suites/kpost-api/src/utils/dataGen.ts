import { randomInt, randomUUID } from 'crypto';

/**
 * Test-data generator — the replacement for `@faker-js/faker`.
 *
 * ## Why this file exists
 *
 * faker 10 is published as **ESM only** (`"type": "module"`, no CommonJS entry). Playwright
 * transpiles specs to CommonJS, so `import { faker } from '@faker-js/faker'` becomes a
 * `require()` of an ESM package and throws at *collection* time:
 *
 *     Error: require() of ES Module @faker-js/faker/dist/index.js not supported
 *
 * Every spec reaches faker through `api.fixture.ts` -> `auth.payload.ts`, so that single
 * import took down all 53 spec files and the suite ran **zero** tests. `tsc --noEmit` stayed
 * clean throughout, because tsconfig's `module: preserve` is not what Playwright uses for its
 * runtime transform — which is exactly why the breakage went unnoticed.
 *
 * The alternative fix, `"type": "module"` in package.json, is worse: 15 files in `src/`,
 * `reporters/` and `scripts/` use `__dirname` or `require()`, including `bugTracker.ts`
 * (which resolves the bug-cache directory that way). All of them would break at once.
 *
 * The dependency bought us ~20 trivial calls. Removing it deletes an entire class of failure
 * from a repository whose stated purpose is auditing someone else's security, and whose
 * dependency footprint is deliberately small for that reason.
 *
 * ## Why it keeps faker's shape
 *
 * The export is named `faker` and mirrors faker's call signatures exactly, so the 18 call
 * sites changed only their import path. A hand-rolled API would have meant rewriting ~120
 * call sites across 17 payload builders, unverifiable by a suite that could not run. Keeping
 * the shape made the repair reviewable as a one-line-per-file diff.
 *
 * ## Determinism
 *
 * Values are random per call, like faker's default. This suite deliberately wants fresh
 * identities per run — a fixed seed would collide against a live, stateful backend that
 * already holds the rows a previous run created.
 *
 * Randomness comes from `crypto.randomInt` rather than `Math.random`: the values become
 * kpostIDs, device identifiers and company names on a shared environment, where a collision
 * shows up as a confusing "already exists" failure rather than as an obvious bug.
 */

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Meera', 'Arjun', 'Divya',
  'Karthik', 'Sneha', 'Rahul', 'Nisha', 'Aditya', 'Kavya', 'Sanjay', 'Pooja',
  'Nikhil', 'Ishita', 'Varun', 'Lakshmi', 'Amit', 'Radhika', 'Suresh', 'Tara',
];

const LAST_NAMES = [
  'Sharma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Gupta', 'Menon', 'Rao',
  'Desai', 'Kulkarni', 'Chopra', 'Bose', 'Verma', 'Joshi', 'Malhotra', 'Pillai',
];

const JOB_TITLES = [
  'Senior Engineer', 'Product Manager', 'Quality Analyst', 'Solutions Architect',
  'Technical Lead', 'Business Analyst', 'Operations Manager', 'Data Engineer',
  'Support Specialist', 'Delivery Manager',
];

const JOB_TYPES = [
  'Engineer', 'Manager', 'Analyst', 'Architect', 'Consultant', 'Administrator',
  'Coordinator', 'Specialist',
];

const COMPANY_PREFIXES = [
  'Sterling', 'Nimbus', 'Vertex', 'Harbour', 'Quantum', 'Meridian', 'Copper',
  'Lattice', 'Beacon', 'Orchid', 'Summit', 'Cobalt',
];

const COMPANY_SUFFIXES = [
  'Technologies', 'Solutions', 'Systems', 'Industries', 'Networks', 'Labs',
  'Enterprises', 'Consulting',
];

const CITIES = [
  'Bengaluru', 'Chennai', 'Hyderabad', 'Pune', 'Mumbai', 'Kochi', 'Jaipur',
  'Ahmedabad', 'Indore', 'Coimbatore', 'Nagpur', 'Lucknow',
];

const STATES = [
  'Karnataka', 'Tamil Nadu', 'Telangana', 'Maharashtra', 'Kerala', 'Rajasthan',
  'Gujarat', 'Madhya Pradesh', 'Uttar Pradesh', 'Punjab',
];

const STREETS = [
  'MG Road', 'Church Street', 'Anna Salai', 'Residency Road', 'Brigade Road',
  'Nehru Nagar', 'Gandhi Marg', 'Park Avenue', 'Ring Road', 'Station Road',
];

const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'dolore', 'magna', 'aliqua',
  'enim', 'minim', 'veniam', 'quis', 'nostrud', 'ullamco', 'laboris', 'aliquip',
];

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const HEX = '0123456789abcdef';

/** Uniform pick. `randomInt` is exclusive of the upper bound, which is what we want here. */
function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)] as T;
}

function fromAlphabet(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** faker accepts either a bare length or an options object; both forms are used in this repo. */
export type AlphanumericOptions = number | { length: number; casing?: 'upper' | 'lower' | 'mixed' };

export const faker = {
  string: {
    /**
     * Mirrors `faker.string.alphanumeric`. Default casing is mixed, matching faker, because
     * `qaIdentifier()` and `qaLabel()` in `safeTestData.ts` rely on the default.
     */
    alphanumeric(options: AlphanumericOptions = 1): string {
      const length = typeof options === 'number' ? options : options.length;
      const casing = typeof options === 'number' ? 'mixed' : (options.casing ?? 'mixed');
      const letters = casing === 'upper' ? UPPER : casing === 'lower' ? LOWER : LOWER + UPPER;
      return fromAlphabet(letters + DIGITS, length);
    },

    numeric(length = 1): string {
      return fromAlphabet(DIGITS, length);
    },

    hexadecimal(options: { length: number; prefix?: string } = { length: 1 }): string {
      const prefix = options.prefix ?? '0x';
      return `${prefix}${fromAlphabet(HEX, options.length)}`;
    },

    /**
     * A real RFC 4122 v4 UUID. These become `deviceID` and `deviceIdentity` values that the
     * backend may parse or store as a UUID column, so a merely "uuid-shaped" string is not
     * good enough.
     */
    uuid(): string {
      return randomUUID();
    },
  },

  number: {
    /** Inclusive of both bounds, matching faker. */
    int(options: { min: number; max: number }): number {
      return randomInt(options.min, options.max + 1);
    },
  },

  person: {
    firstName: (): string => pick(FIRST_NAMES),
    lastName: (): string => pick(LAST_NAMES),
    fullName: (): string => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    jobTitle: (): string => pick(JOB_TITLES),
    jobType: (): string => pick(JOB_TYPES),
  },

  company: {
    name: (): string => `${pick(COMPANY_PREFIXES)} ${pick(COMPANY_SUFFIXES)}`,
  },

  internet: {
    /**
     * `example.com` is reserved by RFC 2606 and cannot resolve to a real mailbox. faker used
     * real-looking consumer domains, which on a suite that fires mail-dispatching endpoints
     * hundreds of times per run is the same hazard `safeTestData.ts` exists to prevent.
     * Anything that can actually trigger a send must still route through `safeTestEmail()`.
     */
    email(): string {
      const handle = `${pick(FIRST_NAMES)}.${pick(LAST_NAMES)}`.toLowerCase();
      return `${handle}${randomInt(1000, 10000)}@example.com`;
    },
  },

  location: {
    city: (): string => pick(CITIES),
    state: (): string => pick(STATES),
    streetAddress: (): string => `${randomInt(1, 400)} ${pick(STREETS)}`,
    secondaryAddress: (): string => `Apt. ${randomInt(100, 1000)}`,
  },

  lorem: {
    words(count = 3): string {
      return Array.from({ length: count }, () => pick(LOREM)).join(' ');
    },

    sentence(wordCount = 6): string {
      const words = Array.from({ length: wordCount }, () => pick(LOREM)).join(' ');
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
    },

    paragraph(sentenceCount = 3): string {
      return Array.from({ length: sentenceCount }, () => faker.lorem.sentence()).join(' ');
    },

    paragraphs(count = 3): string {
      return Array.from({ length: count }, () => faker.lorem.paragraph()).join('\n');
    },
  },
};
