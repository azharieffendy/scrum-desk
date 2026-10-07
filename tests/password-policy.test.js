/*
 * The password rule shared by the server and the sign-in forms. Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../public/password-policy.js');

test('a password needs 10+ characters with lower, upper, a number and a symbol', () => {
  assert.equal(policy.problem('Abcdef12!x'), null);
  assert.equal(policy.problem('Ünïcode-Pass9'), null);
  assert.match(policy.problem('Abc12!x'), /10 characters/);
  assert.match(policy.problem(''), /10 characters/);
  assert.match(policy.problem(undefined), /10 characters/);
  assert.match(policy.problem('ABCDEFG12!'), /lowercase/);
  assert.match(policy.problem('abcdefg12!'), /uppercase/);
  assert.match(policy.problem('Abcdefghi!'), /number/);
  assert.match(policy.problem('Abcdefghi1'), /special/);
  assert.match(policy.problem('Abcdefgh 1'), /special/, 'a space is not a special character');
});

test('the hint states the whole rule', () => {
  assert.equal(policy.MIN_LENGTH, 10);
  assert.match(policy.HINT, /10/);
});
