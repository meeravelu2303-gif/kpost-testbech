import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';

/**
 * Most User Profile V2 mutation endpoints (updateBasicInformation, updateContactInformation,
 * updateDesignation, setProfilePrivacy, changePassword, changeOrForgotAccessCode,
 * saveOrUpdateExperienceDetails, deleteExperienceDetail, updateProfileImage, removeProfileImage,
 * advancedSearch, autoSearchWithName, getDigitalCard) share the same structured envelope.
 */
export const profileMutationResponseSchema = dataEnvelopeSchema;

export type ProfileMutationResponse = z.infer<typeof profileMutationResponseSchema>;
