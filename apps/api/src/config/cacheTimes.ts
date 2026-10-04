/**
 * How long each cache that decides whether a request is let in may answer without the database
 * (4 Oct 2026). The numbers live in cacheTimes.json, which the deletion script reads too: it suspends
 * a school and waits out the longest of them before deleting it (docs/AUDIT-2026-09.md, fix (a2)).
 * Read from the file, never restated here; cacheTimes.test.ts fails on a typed-in expiry for these
 * caches anywhere in src.
 */
import config from './cacheTimes.json';

/** The school row requireActiveSchool serves from the in-process cache (schoolCacheKey(id, 'data')). */
export const SCHOOL_CACHE_SECONDS: number = config.school_seconds;

/** Redis `user_active:<id>`: whether an account is active, read by verifyToken. */
export const USER_ACTIVE_CACHE_SECONDS: number = config.user_active_seconds;

/** Redis `must_change_password:<id>`, read by requirePasswordChanged. */
export const MUST_CHANGE_PASSWORD_CACHE_SECONDS: number = config.must_change_password_seconds;
