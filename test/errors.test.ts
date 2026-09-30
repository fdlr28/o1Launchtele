import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/domain/units.js';
import { TxUnknownError, UserFacingError, describeError, setErrorSanitizer } from '../src/errors.js';
import { ApiError } from '../src/o1/client.js';

afterEach(() => setErrorSanitizer((text) => text));

describe('describeError', () => {
  it('explains the errors the bot raises itself', () => {
    expect(describeError(new UserFacingError('Sudah jelas'))).toBe('Sudah jelas');
    expect(describeError(new InputError('Format salah'))).toBe('Format salah');
    expect(describeError(new TxUnknownError('Belum jelas', '0xabc', 8453))).toBe('Belum jelas');
    expect(describeError(new Error('socket hang up'))).toBe('Terjadi kesalahan: socket hang up');
  });

  it('never throws, whatever it is given (it runs inside catch blocks after money has moved)', () => {
    const noPrototype = Object.create(null); // String() of it throws
    const throwingGetter = { get message(): string { throw new Error('boom'); } };
    for (const weird of [noPrototype, throwingGetter, undefined, null, 5, Symbol('x'), { toString: () => { throw new Error('nope'); } }]) {
      expect(() => describeError(weird), String(typeof weird)).not.toThrow();
      expect(typeof describeError(weird)).toBe('string');
    }
  });

  it('reads API error fields defensively: they are text from a server, not numbers it promised', () => {
    const problem = { status: 422, code: 'insufficient_balance', asset: 5, actual_raw: 'many', required_raw: { deep: true } };
    const text = describeError(new ApiError(422, 'insufficient_balance', 'x', problem as never));
    expect(text).toContain('Saldo kurang');
    // a real native shortfall is still formatted properly
    const native = describeError(
      new ApiError(422, 'insufficient_balance', 'x', { status: 422, code: 'insufficient_balance', asset: '0x0000000000000000000000000000000000000000', actual_raw: '1000000000000000', required_raw: '2000000000000000' }),
    );
    expect(native).toContain('punya 0.001, butuh 0.002 (native)');
  });

  it('runs its result through the installed sanitizer, and survives a sanitizer that breaks', () => {
    setErrorSanitizer((text) => text.replaceAll('SECRET', '<redacted>'));
    expect(describeError(new Error('key SECRET leaked'))).toBe('Terjadi kesalahan: key <redacted> leaked');
    setErrorSanitizer(() => {
      throw new Error('sanitizer bug');
    });
    expect(describeError(new Error('x'))).toMatch(/tidak bisa dijelaskan/);
  });
});
