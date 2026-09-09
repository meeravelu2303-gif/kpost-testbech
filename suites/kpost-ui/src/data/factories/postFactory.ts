/**
 * Post factory (Factory pattern for test data).
 *
 * Why a factory and not just JSON fixtures?
 *  - Uniqueness: every test gets a distinct title (timestamped + random) so
 *    parallel tests never collide in a shared backend feed — the key to true
 *    test independence and no state leakage.
 *  - Intent-revealing overrides: a test states only the fields it cares about;
 *    the factory fills realistic defaults for the rest.
 *
 * Static fixtures (posts.json) remain for boundary constants and canonical
 * examples; the factory is for per-test, mutable, unique instances.
 */
import { faker } from '@faker-js/faker';
import type { Post } from '../../types';

let sequence = 0;

/** Build a valid Post, overriding any field per test need. */
export function buildPost(overrides: Partial<Post> = {}): Post {
  sequence += 1;
  const unique = `${Date.now()}-${sequence}-${faker.string.alphanumeric(4)}`;

  return {
    title: `Automated Post ${unique}`,
    body: faker.lorem.paragraphs(2),
    tags: [faker.word.noun(), faker.word.adjective()],
    visibility: 'public',
    ...overrides,
  };
}

/** A post whose title sits exactly on the max-length boundary. */
export function buildMaxLengthTitlePost(maxTitleLength: number, overrides: Partial<Post> = {}): Post {
  return buildPost({
    title: 'A'.repeat(maxTitleLength),
    ...overrides,
  });
}

/** A batch of unique posts — handy for feed/pagination/virtualization tests. */
export function buildPosts(count: number, overrides: Partial<Post> = {}): Post[] {
  return Array.from({ length: count }, () => buildPost(overrides));
}
