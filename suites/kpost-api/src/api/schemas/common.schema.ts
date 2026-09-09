import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';

/**
 * Common Reference Data V2 endpoints (sendOTP, validateOTP, countries, getStates, pinCode,
 * getProfession, getDesignation, domain, forgotPasswordUpdate, ...) share the same
 * structured envelope with an opaque `data` payload (array or object depending on endpoint).
 */
export const commonDataResponseSchema = dataEnvelopeSchema;

export type CommonDataResponse = z.infer<typeof commonDataResponseSchema>;
