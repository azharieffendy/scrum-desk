/* ================================================================
   Password rule — pure and shared: server.js requires it, the browser
   loads it before app-auth.js, so both refuse exactly the same passwords.
   Only new passwords are checked; signing in accepts older ones.
   ================================================================ */
'use strict';

const PasswordPolicy = (() => {
  const MIN_LENGTH = 10;
  const HINT = 'at least ' + MIN_LENGTH + ' characters, with upper- and lowercase letters, a number and a special character';

  /** Why a new password is refused, or null when it is accepted. */
  function problem(password) {
    const p = String(password == null ? '' : password);
    if (p.length < MIN_LENGTH) return 'Password needs at least ' + MIN_LENGTH + ' characters.';
    if (!/\p{Ll}/u.test(p)) return 'Password needs a lowercase letter.';
    if (!/\p{Lu}/u.test(p)) return 'Password needs an uppercase letter.';
    if (!/\p{Nd}/u.test(p)) return 'Password needs a number.';
    if (!/[^\p{L}\p{Nd}\s]/u.test(p)) return 'Password needs a special character, such as ! - _ @ #.';
    return null;
  }

  return { MIN_LENGTH, HINT, problem };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PasswordPolicy;
