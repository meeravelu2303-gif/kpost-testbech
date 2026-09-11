import type { Validator } from '../types';
import { authenticationValidator } from './authentication';
import { authorizationValidator } from './authorization';
import { databaseValidator } from './database';
import { errorContractValidator } from './errorContract';
import { executionValidator } from './execution';
import { performanceValidator } from './performance';
import { requestValidator } from './request';
import {
  contentTypeValidator,
  headerValidator,
  schemaValidator,
  statusValidator,
  structureValidator,
} from './response';
import { securityValidator } from './security';

/**
 * Every validator the engine runs.
 *
 * **This is the only place a new check is added.** Registering one here applies it to every
 * endpoint in the registry — no endpoint file changes, no spec changes.
 *
 * `businessRules` has no validator on purpose: a rule like "a Confidential Copy recipient must
 * stay hidden from other recipients" is not derivable from a contract. Those live in the module
 * specs under `tests/`, and the pipeline reports the stage as an explicit skip so the report never
 * implies the engine covers them.
 */
export const VALIDATORS: Validator[] = [
  authenticationValidator,
  authorizationValidator,
  requestValidator,
  executionValidator,
  statusValidator,
  structureValidator,
  schemaValidator,
  contentTypeValidator,
  headerValidator,
  errorContractValidator,
  performanceValidator,
  securityValidator,
  databaseValidator,
];

export {
  authenticationValidator,
  authorizationValidator,
  contentTypeValidator,
  databaseValidator,
  errorContractValidator,
  executionValidator,
  headerValidator,
  performanceValidator,
  requestValidator,
  schemaValidator,
  securityValidator,
  statusValidator,
  structureValidator,
};
