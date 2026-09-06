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

  window.NiccAuth = {
    signUp: signUp,
    logIn: logIn,
    logOut: logOut,
    getCurrentUser: getCurrentUser
  };
})();
