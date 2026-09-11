import type { EndpointDefinition } from '../engine';
import { katchupEndpoints } from './katchup';

/**
 * Every endpoint the engine drives.
 *
 * To add one: declare it in a module file here and add the export below. It then receives the
 * full validation pipeline — authentication, authorization, request fuzzing, status, structure,
 * schema, content-type, headers, error contract, performance, security, database. No validation
 * code is written per endpoint.
 */
export const ALL_ENDPOINTS: EndpointDefinition[] = [...katchupEndpoints];

export { katchupEndpoints };
