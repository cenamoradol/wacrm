import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  passwordError,
  MIN_PASSWORD_LENGTH,
} from './credentials';

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('agent@example.com')).toBe(true);
    expect(isValidEmail('  agent@example.com  ')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.co.uk')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('agent')).toBe(false);
    expect(isValidEmail('agent@')).toBe(false);
    expect(isValidEmail('agent@example')).toBe(false);
    expect(isValidEmail('agent @example.com')).toBe(false);
    expect(isValidEmail('agent@exa mple.com')).toBe(false);
  });
});

describe('passwordError', () => {
  it('accepts a password at or above the minimum', () => {
    expect(passwordError('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordError('correct horse battery')).toBeNull();
  });

  it('rejects a too-short password', () => {
    expect(passwordError('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(
      /at least 6 characters/
    );
    expect(passwordError('')).toMatch(/at least 6 characters/);
  });
});
