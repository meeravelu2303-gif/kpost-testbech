/**
 * User factory (Factory pattern for test data).
 *
 * Generates unique, realistic user records for tests that create accounts
 * (e.g. sign-up flows). Seeded test users used for login come from env config,
 * not this factory — never generate credentials for accounts that must already
 * exist in the backend.
 */
import { faker } from '@faker-js/faker';
import type { User, UserRole } from '../../types';

let sequence = 0;

/** Build a unique, registrable user. */
export function buildUser(overrides: Partial<User> = {}): User {
  sequence += 1;
  const unique = `${Date.now()}-${sequence}`;

  return {
    email: `qa.${unique}@kpost.test`,
    // Meets a typical strong-password policy: upper, lower, digit, symbol, 12+.
    password: `Qa!${faker.string.alphanumeric(8)}9`,
    displayName: faker.person.fullName(),
    role: 'standard' as UserRole,
    ...overrides,
  };
}
