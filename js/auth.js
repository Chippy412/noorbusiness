// js/auth.js
(function () {
  "use strict";

  // captchaToken is only passed when Supabase's own Turnstile check is on
  // (Authentication > Attack Protection); Supabase verifies it server-side.
  async function signUp(email, password, captchaToken) {
    var options = captchaToken ? { captchaToken: captchaToken } : undefined;
    var result = await window.NiccSupabase.auth.signUp({ email: email, password: password, options: options });
    if (result.error) throw result.error;
    // If the Supabase project has "Confirm email" turned on, signUp
    // returns a user but no session -- the caller needs to know which
    // happened so it can show "check your email" instead of "logged in".
    return { user: result.data.user, session: result.data.session };
  }

  async function resendConfirmation(email) {
    var result = await window.NiccSupabase.auth.resend({ type: "signup", email: email });
    if (result.error) throw result.error;
  }

  async function logIn(email, password) {
    var result = await window.NiccSupabase.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data.user;
  }

  async function logOut() {
    var result = await window.NiccSupabase.auth.signOut();
    if (result.error) throw result.error;
  }

  async function getCurrentUser() {
    // getSession() reads the session Supabase already restored from
    // localStorage and reliably awaits the client's internal init.
    // getUser() hits the network to revalidate and can return "Auth
    // session missing" if called at page-boot time, before that init
    // finishes -- which happens on every direct load of a hash route
    // like #/account, so it must not be used here.
    var result = await window.NiccSupabase.auth.getSession();
    if (result.error || !result.data.session) return null;
    return result.data.session.user;
  }

  // Whether the current session still needs a second factor before it's
  // treated as fully signed in (currentLevel aal1, but the account has a
  // verified TOTP factor so nextLevel is aal2).
  async function needsMfaChallenge() {
    var result = await window.NiccSupabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (result.error) return false;
    return result.data.nextLevel === "aal2" && result.data.currentLevel !== "aal2";
  }

  async function requestPasswordReset(email, redirectTo) {
    var result = await window.NiccSupabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
    if (result.error) throw result.error;
  }

  async function updatePassword(newPassword) {
    var result = await window.NiccSupabase.auth.updateUser({ password: newPassword });
    if (result.error) throw result.error;
  }

  function onAuthEvent(handler) {
    window.NiccSupabase.auth.onAuthStateChange(function (event, session) {
      handler(event, session);
    });
  }

  /* ---------- Two-factor authentication (TOTP) ---------- */

  async function mfaListFactors() {
    var result = await window.NiccSupabase.auth.mfa.listFactors();
    if (result.error) throw result.error;
    return result.data.totp || [];
  }

  async function mfaEnroll() {
    // A setup that was started but never confirmed leaves an "unverified"
    // factor behind, and Supabase refuses a second enroll while it exists.
    // Clear those first so "Set up two-factor" always works on a retry.
    var existing = await window.NiccSupabase.auth.mfa.listFactors();
    if (!existing.error && existing.data && existing.data.all) {
      var stale = existing.data.all.filter(function (f) { return f.status === "unverified"; });
      for (var i = 0; i < stale.length; i++) {
        await window.NiccSupabase.auth.mfa.unenroll({ factorId: stale[i].id });
      }
    }
    var result = await window.NiccSupabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "NICC Business " + Date.now() });
    if (result.error) throw result.error;
    return result.data; // { id, totp: { qr_code, secret, uri } }
  }

  async function mfaVerifyEnrollment(factorId, code) {
    var challenge = await window.NiccSupabase.auth.mfa.challenge({ factorId: factorId });
    if (challenge.error) throw challenge.error;
    var verify = await window.NiccSupabase.auth.mfa.verify({
      factorId: factorId,
      challengeId: challenge.data.id,
      code: code
    });
    if (verify.error) throw verify.error;
    return verify.data;
  }

  async function mfaUnenroll(factorId) {
    var result = await window.NiccSupabase.auth.mfa.unenroll({ factorId: factorId });
    if (result.error) throw result.error;
  }

  // Completes the login-time 2FA step: challenges the given factor with
  // the code the user just typed and verifies it, stepping the session
  // up from aal1 to aal2.
  async function mfaChallengeAndVerify(factorId, code) {
    return mfaVerifyEnrollment(factorId, code);
  }

  window.NiccAuth = {
    signUp: signUp,
    resendConfirmation: resendConfirmation,
    logIn: logIn,
    logOut: logOut,
    getCurrentUser: getCurrentUser,
    needsMfaChallenge: needsMfaChallenge,
    requestPasswordReset: requestPasswordReset,
    updatePassword: updatePassword,
    onAuthEvent: onAuthEvent,
    mfaListFactors: mfaListFactors,
    mfaEnroll: mfaEnroll,
    mfaVerifyEnrollment: mfaVerifyEnrollment,
    mfaUnenroll: mfaUnenroll,
    mfaChallengeAndVerify: mfaChallengeAndVerify
  };
})();
