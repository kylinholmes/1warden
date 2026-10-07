import { expect, it } from 'vitest';
import { TwoFactorRequiredError } from '@coffer/api';
import { serializeError } from '../../extension/application-rpc';
import { twoFactorChallenge } from './auth-error';

it('offers OTP for the actual API challenge locally and after RPC serialization', () => {
  const error = new TwoFactorRequiredError([0], { '0': null }, {});
  const expected = { providers: [0], providersInfo: { '0': null } };
  expect(twoFactorChallenge(error)).toEqual(expected);
  expect(twoFactorChallenge(serializeError(error))).toEqual(expected);
  expect(twoFactorChallenge(new Error('Incorrect password'))).toBeNull();
});
