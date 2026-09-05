// js/auth.js
(function () {
  "use strict";

  async function signUp(email, password) {
    var result = await window.NiccSupabase.auth.signUp({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data.user;
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
    var result = await window.NiccSupabase.auth.getUser();
    if (result.error) return null;
    return result.data.user;
  }

  window.NiccAuth = {
    signUp: signUp,
    logIn: logIn,
    logOut: logOut,
    getCurrentUser: getCurrentUser
  };
})();
