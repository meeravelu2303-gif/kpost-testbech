import { randomInt, randomUUID } from 'crypto';

/**
 * Deterministic-shape test data, with the same surface as the parts of `faker` this suite
 * uses.
 *
 * Written rather than depended on because the shapes needed here are few and the dependency
 * is large — and because one behaviour had to change: `internet.email()` returns an
 * `example.com` address (reserved by RFC 2606, cannot resolve to a real mailbox) instead of
 * faker's real-looking consumer domains. On a suite that fires mail-**sending** endpoints
 * hundreds of times per run, a generated address that happens to be deliverable is not a
 * cosmetic difference.
 */

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Arjun', 'Diya', 'Ishaan', 'Kavya', 'Meera', 'Nikhil',
  'Priya', 'Rahul', 'Riya', 'Rohan', 'Sanya', 'Vikram', 'Zara', 'Aditya',
] as const;

const LAST_NAMES = [
  'Sharma', 'Verma', 'Nair', 'Iyer', 'Reddy', 'Patel', 'Kumar', 'Menon',
  'Chopra', 'Bose', 'Gupta', 'Rao', 'Desai', 'Joshi', 'Kapoor', 'Malhotra',
] as const;

const COMPANY_PREFIXES = [
  'Northwind', 'Blue Ridge', 'Everest', 'Coastal', 'Meridian', 'Lakeside',
  'Summit', 'Harbour', 'Cascade', 'Pinnacle',
] as const;

const COMPANY_SUFFIXES = [
  'Logistics', 'Analytics', 'Systems', 'Partners', 'Industries', 'Labs',
  'Holdings', 'Networks', 'Solutions', 'Consulting',
] as const;

const JOB_TITLES = [
  'Operations Manager', 'Financial Controller', 'Account Director',
  'Procurement Lead', 'Regional Manager', 'Programme Director',
] as const;

const CITIES = [
  'Bengaluru', 'Chennai', 'Pune', 'Hyderabad', 'Kochi', 'Mumbai', 'Jaipur', 'Indore',
] as const;

const LOREM = [
  'schedule', 'invoice', 'quarterly', 'attached', 'revised', 'proposal', 'confirm',
  'shipment', 'contract', 'approval', 'summary', 'forecast', 'meeting', 'update',
  'reconciled', 'dispatch', 'inventory', 'renewal',
] as const;

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
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

/** Accepts either a bare length or an options object; both forms are used in this repo. */
export type AlphanumericOptions = number | { length: number; casing?: 'upper' | 'lower' | 'mixed' };

export const faker = {
  string: {
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
     * A real RFC 4122 v4 UUID.
     *
     * The attachment routes address objects by UUID and the service may parse or store the
     * value as a UUID column, so a merely "uuid-shaped" string is not good enough — a
     * malformed one would be rejected by the parser before it ever reached the lookup the
     * test is trying to exercise.
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
  },

  company: {
    name: (): string => `${pick(COMPANY_PREFIXES)} ${pick(COMPANY_SUFFIXES)}`,
  },

  internet: {
    /** `example.com` is reserved by RFC 2606 and cannot resolve to a real mailbox. */
    email(): string {
      const handle = `${pick(FIRST_NAMES)}.${pick(LAST_NAMES)}`.toLowerCase();
      return `${handle}${randomInt(1000, 10000)}@example.com`;
    },

    url(): string {
      return `https://www.${pick(COMPANY_PREFIXES).toLowerCase().replace(/\s+/g, '')}.example.com`;
    },
  },

  location: {
    city: (): string => pick(CITIES),
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
  },
};
