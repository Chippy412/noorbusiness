#!/usr/bin/env python3
"""Run every Supabase migration against a real Postgres and test the rules.

    pip3 install --user pgserver "psycopg[binary]"
    python3 tests/db/run.py

Creates a throwaway database, loads tests/db/supabase_shim.sql (Supabase's
roles, auth and storage), applies supabase/schema.sql, seed.sql and every
migration in order, applies the migrations a SECOND time (they all claim to
be safe to re-run), then acts as visitors, owners, volunteers and moderators
and checks that every action is allowed or refused as intended.
"""
import os
import sys
import uuid
import json
import traceback

import pgserver
import psycopg

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MIG = os.path.join(ROOT, "supabase", "migrations")
SECRET = "testsecret_123"

MIGRATIONS = [
    "2026-09-06-business-photos.sql",
    "2026-09-12-write-rate-limits.sql",
    "2026-09-13-contact-messages.sql",
    "2026-09-13-reviews.sql",
    "2026-09-13-require-mfa-for-owner-writes.sql",
    "2026-10-04-hardening.sql",
    "2026-10-04-insert-column-grants.sql",
    "2026-10-04-lock-public-inserts.sql",
    "2026-10-04-notify-triggers.sql",
    "2026-10-05-admin.sql",
    "2026-10-06-roles.sql",
    "2026-10-07-fixes.sql",
    "2026-10-08-review-fixes.sql",
]


def read(path):
    sql = open(path).read()
    # pg_net isn't installable here; the shim provides net.http_post instead.
    sql = sql.replace("create extension if not exists pg_net with schema extensions;", "")
    # Only the trigger file gets the secret filled in (scripts/finish-setup.sh
    # does the same); other files mention the placeholder on purpose.
    if path.endswith("notify-triggers.sql"):
        sql = sql.replace("__NOTIFY_SECRET__", SECRET)
    return sql


def setup():
    data = os.path.join(os.environ.get("TMPDIR", "/tmp"), "nicc-pgtest")
    srv = pgserver.get_server(data, cleanup_mode=None)
    dbname = "t_" + uuid.uuid4().hex[:8]
    with psycopg.connect(srv.get_uri(), autocommit=True) as c:
        c.execute("create database " + dbname)
    uri = srv.get_uri().replace("/postgres?", "/" + dbname + "?")
    conn = psycopg.connect(uri, autocommit=True)
    conn.execute(open(os.path.join(os.path.dirname(__file__), "supabase_shim.sql")).read())
    conn.execute(read(os.path.join(ROOT, "supabase", "schema.sql")))
    conn.execute(read(os.path.join(ROOT, "supabase", "seed.sql")))
    for rnd in (1, 2):
        for m in MIGRATIONS:
            try:
                conn.execute(read(os.path.join(MIG, m)))
            except Exception as e:
                raise SystemExit("MIGRATION FAILED (pass %d) %s:\n%s" % (rnd, m, e))
    print("migrations: applied twice, all OK")
    return conn


# ---------------------------------------------------------------- helpers
class Ctx:
    def __init__(self, conn):
        self.conn = conn

    def as_(self, uid=None, aal="aal1", role=None):
        """Switch to a PostgREST-like caller for the current transaction."""
        role = role or ("authenticated" if uid else "anon")
        claims = {"role": role, "aal": aal}
        if uid:
            claims["sub"] = str(uid)
        self.conn.execute("reset role")
        self.conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
        self.conn.execute("set local role " + role)

    def admin(self):
        self.conn.execute("reset role")
        self.conn.execute("select set_config('request.jwt.claims', '', true)")

    def q(self, sql, args=None):
        cur = self.conn.execute(sql, args or ())
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return None

    def one(self, sql, args=None):
        rows = self.q(sql, args)
        return rows[0][0] if rows else None

    def fails(self, sql, args=None, contains=None):
        sp = "sp_" + uuid.uuid4().hex[:6]
        self.conn.execute("savepoint " + sp)
        try:
            self.conn.execute(sql, args or ())
        except psycopg.Error as e:
            self.conn.execute("rollback to savepoint " + sp)
            msg = str(e)
            if contains and contains.lower() not in msg.lower():
                raise AssertionError("failed, but with the wrong error: %s (expected %r)" % (msg, contains))
            return msg
        self.conn.execute("release savepoint " + sp)
        raise AssertionError("expected this to be refused but it succeeded: " + sql)

    def user(self, email, mfa=False):
        self.admin()
        uid = self.one("insert into auth.users (email) values (%s) returning id", (email,))
        if mfa:
            self.q("insert into auth.mfa_factors (user_id, status) values (%s, 'verified')", (uid,))
        return uid

    def business(self, owner, status="approved", name="Biz"):
        self.admin()
        return self.one(
            "insert into businesses (owner_id, name, category, neighborhood, description, long_description, status)"
            " values (%s, %s, 'Restaurants', 'Dublin', 'short', 'long', %s) returning id", (owner, name, status))


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


# ----------------------------------------------------------------- visitors
@test
def anon_reads_only_approved(t):
    o = t.user("o@x.co")
    a = t.business(o, "approved", "Live")
    p = t.business(o, "pending", "Hidden")
    t.as_()
    names = [r[0] for r in t.q("select name from businesses")]
    assert "Live" in names and "Hidden" not in names, names


@test
def anon_cannot_write_anything(t):
    o = t.user("o@x.co")
    b = t.business(o)
    t.as_()
    t.fails("insert into businesses (name, category, neighborhood, description, long_description) values ('x','x','x','x','x')")
    t.fails("insert into contact_messages (name, email, message) values ('a','a@b.co','hi')")
    t.fails("insert into subscribers (email) values ('a@b.co')")
    t.fails("insert into claims (business_id, requester_id) values (%s, %s)", (b, o))
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'a', 5, 'b')", (b, o))
    t.fails("insert into admins (user_id) values (%s)", (o,))
    t.fails("insert into saved_listings (user_id, business_id) values (%s, %s)", (o, b))
    t.q("update businesses set name = 'hacked' where id = %s", (b,))  # may be a silent no-op or refused
    t.admin()
    assert t.one("select name from businesses where id = %s", (b,)) == "Biz"


@test
def anon_cannot_read_private_tables(t):
    o = t.user("o@x.co")
    t.admin()
    t.q("insert into contact_messages (name, email, message) values ('a','a@b.co','secret')")
    t.q("insert into subscribers (email) values ('s@b.co')")
    t.q("insert into admins (user_id, role) values (%s, 'moderator')", (o,))
    t.as_()
    for table in ("contact_messages", "subscribers", "admins", "business_edits", "saved_listings", "claims"):
        sp = "sp_" + uuid.uuid4().hex[:6]
        t.conn.execute("savepoint " + sp)
        try:
            rows = t.q("select * from " + table)
            assert rows == [], "%s leaked to visitors: %r" % (table, rows)
        except psycopg.errors.InsufficientPrivilege:
            t.conn.execute("rollback to savepoint " + sp)


@test
def anon_cannot_call_admin_or_owner_functions(t):
    t.as_()
    for call in ("select admin_queue()", "select admin_all_businesses()", "select admin_team()",
                 "select owner_update_business(gen_random_uuid(), '{}'::jsonb)",
                 "select admin_add_member('a@b.co', 'moderator')"):
        t.fails(call)


@test
def anon_sees_only_approved_reviews(t):
    o = t.user("o@x.co"); r = t.user("r@x.co"); r2 = t.user("r2@x.co")
    b = t.business(o)
    t.admin()
    t.q("insert into reviews (business_id, author_id, author_name, rating, body, status) values (%s,%s,'A',5,'ok','approved')", (b, r))
    t.q("insert into reviews (business_id, author_id, author_name, rating, body, status) values (%s,%s,'B',1,'spam','pending')", (b, r2))
    t.as_()
    assert [x[0] for x in t.q("select author_name from reviews")] == ["A"]


# ------------------------------------------------------------------- owners
@test
def owner_creates_pending_listing_only(t):
    o = t.user("o@x.co")
    t.as_(o)
    t.q("insert into businesses (owner_id, name, category, neighborhood, description, long_description, halal_status)"
        " values (%s, 'New', 'Restaurants', 'Dublin', 's', 'l', 'some')", (o,))
    t.fails("insert into businesses (owner_id, name, category, neighborhood, description, long_description, status)"
            " values (%s, 'X', 'R', 'D', 's', 'l', 'approved')", (o,))
    t.fails("insert into businesses (owner_id, name, category, neighborhood, description, long_description, featured)"
            " values (%s, 'X', 'R', 'D', 's', 'l', true)", (o,))
    t.fails("insert into businesses (owner_id, name, category, neighborhood, description, long_description, badges)"
            " values (%s, 'X', 'R', 'D', 's', 'l', '{halal}')", (o,))
    t.fails("insert into businesses (owner_id, name, category, neighborhood, description, long_description)"
            " values (gen_random_uuid(), 'X', 'R', 'D', 's', 'l')")  # someone else as owner
    t.fails("insert into businesses (owner_id, name, category, neighborhood, description, long_description, halal_status)"
            " values (%s, 'X', 'R', 'D', 's', 'l', 'bogus')", (o,))


@test
def owner_cannot_update_table_directly(t):
    o = t.user("o@x.co"); b = t.business(o, "pending")
    t.as_(o)
    t.fails("update businesses set name = 'x' where id = %s", (b,))
    t.fails("update businesses set status = 'approved' where id = %s", (b,))


@test
def owner_edit_on_pending_listing_applies_directly(t):
    o = t.user("o@x.co"); b = t.business(o, "pending")
    t.as_(o)
    res = t.one("select owner_update_business(%s, %s::jsonb)", (b, json.dumps({"name": "Renamed", "website": "https://ex.com"})))
    assert res["pending"] is False, res
    t.admin()
    assert t.q("select name, website from businesses where id = %s", (b,))[0] == ("Renamed", "https://ex.com")


@test
def owner_edit_on_live_listing_is_queued_and_live_unchanged(t):
    o = t.user("o@x.co"); b = t.business(o, "approved", "Live Name")
    t.admin(); before = t.one("select count(*) from net.requests")
    t.as_(o)
    res = t.one("select owner_update_business(%s, %s::jsonb)", (b, json.dumps({"name": "New Name", "description": "short"})))
    assert res == {"status": "approved", "pending": True}, res
    t.admin()
    assert t.one("select name from businesses where id = %s", (b,)) == "Live Name"
    assert t.one("select changes from business_edits where business_id = %s", (b,)) == {"name": "New Name"}  # unchanged field dropped
    assert t.one("select count(*) from net.requests") == before + 1, "queuing an edit should alert volunteers once"
    # Saving again while pending: edit merges, no second alert.
    t.as_(o)
    t.q("select owner_update_business(%s, %s::jsonb)", (b, json.dumps({"phone": "614"})))
    t.admin()
    assert t.one("select changes from business_edits where business_id = %s", (b,)) == {"name": "New Name", "phone": "614"}
    assert t.one("select count(*) from net.requests") == before + 1, "repeat saves must not re-alert"
    # Reverting every field to the live value drops the pending edit.
    t.as_(o)
    res = t.one("select owner_update_business(%s, %s::jsonb)", (b, json.dumps({"name": "Live Name", "phone": ""})))
    assert res["pending"] is False, res
    t.admin()
    assert t.one("select count(*) from business_edits where business_id = %s", (b,)) == 0


@test
def owner_hours_go_live_immediately(t):
    o = t.user("o@x.co"); b = t.business(o, "approved")
    t.as_(o)
    res = t.one("select owner_update_business(%s, %s::jsonb)", (b, json.dumps({"hours": [["Mon", "9-5"]]})))
    assert res["pending"] is False
    t.admin()
    assert t.one("select hours from businesses where id = %s", (b,)) == [["Mon", "9-5"]]


@test
def owner_edit_validation(t):
    o = t.user("o@x.co"); b = t.business(o, "pending")
    t.as_(o)
    f = lambda d: "select owner_update_business('%s', '%s'::jsonb)" % (b, json.dumps(d).replace("'", "''"))
    t.fails(f({"website": "http://insecure.com"}), contains="https")
    t.fails(f({"website": "javascript:alert(1)"}), contains="https")
    t.fails(f({"photo_url": "https://evil.example/x.jpg"}), contains="uploaded through the site")
    t.fails(f({"name": ""}), contains="required")
    t.fails(f({"name": "x" * 121}), contains="too long")
    t.fails(f({"description": 5}), contains="text")
    t.fails(f({"hours": [["Mon"]]}), contains="hours")
    t.fails(f({"hours": "Mon 9-5"}), contains="hours")
    ok = "https://abc.supabase.co/storage/v1/object/public/business-photos/%s/1.jpg" % b
    t.q(f({"photo_url": ok}))
    # Fields owners may not touch are ignored, not applied.
    t.q(f({"status": "approved", "featured": True, "badges": ["halal"], "owner_id": str(uuid.uuid4())}))
    t.admin()
    assert t.q("select status, featured, badges, owner_id from businesses where id = %s", (b,))[0] == ("pending", False, [], o)


@test
def owner_cannot_edit_someone_elses_listing(t):
    o = t.user("o@x.co"); x = t.user("x@x.co"); b = t.business(o, "pending")
    t.as_(x)
    t.fails("select owner_update_business(%s, '{\"name\":\"pwned\"}'::jsonb)", (b,), contains="not found")


@test
def owner_with_2fa_needs_aal2(t):
    o = t.user("o@x.co", mfa=True); b = t.business(o, "pending")
    t.as_(o, aal="aal1")
    t.fails("select owner_update_business(%s, '{\"name\":\"a\"}'::jsonb)", (b,), contains="two-factor")
    t.as_(o, aal="aal2")
    t.q("select owner_update_business(%s, '{\"name\":\"a\"}'::jsonb)", (b,))


@test
def rejected_listing_is_resubmitted_when_edited(t):
    o = t.user("o@x.co"); b = t.business(o, "rejected")
    t.as_(o)
    res = t.one("select owner_update_business(%s, '{\"description\":\"fixed it\"}'::jsonb)", (b,))
    assert res == {"status": "pending", "pending": False}, res


@test
def stale_edit_dropped_after_unpublish(t):
    mod, vol = team(t)
    o = t.user("o@x.co"); b = t.business(o, "approved", "Live")
    t.as_(o); t.q("select owner_update_business(%s, '{\"name\":\"Queued\"}'::jsonb)", (b,))
    t.as_(mod, aal="aal2"); t.q("select admin_set_listing_status(%s, 'pending')", (b,))
    t.as_(o); t.q("select owner_update_business(%s, '{\"name\":\"Newer\"}'::jsonb)", (b,))
    t.admin()
    assert t.one("select name from businesses where id = %s", (b,)) == "Newer"
    assert t.one("select count(*) from business_edits where business_id = %s", (b,)) == 0


@test
def claim_approval_drops_previous_owners_draft(t):
    mod, vol = team(t)
    a = t.user("a@x.co"); c = t.user("c@x.co"); b = t.business(a, "approved")
    t.as_(a); t.q("select owner_update_business(%s, '{\"phone\":\"private draft\"}'::jsonb)", (b,))
    t.as_(c); t.q("insert into claims (business_id, requester_id) values (%s, %s)", (b, c))
    t.as_(mod, aal="aal2")
    cid = t.one("select admin_queue()")["claims"][0]["id"]
    t.q("select admin_resolve_claim(%s, true)", (cid,))
    t.as_(c)
    assert t.q("select * from business_edits") == [], "new owner can see the old owner's draft"


@test
def owners_have_no_direct_update_privilege(t):
    t.admin()
    cols = [r[0] for r in t.q("select column_name from information_schema.columns where table_schema='public' and table_name='businesses'")]
    granted = [c for c in cols if t.one("select has_column_privilege('authenticated', 'public.businesses', %s, 'UPDATE')", (c,))]
    assert granted == [], "authenticated can still UPDATE columns directly: %s" % granted


@test
def no_reviews_or_claims_on_hidden_listings(t):
    o = t.user("o@x.co"); u = t.user("u@x.co"); hidden = t.business(o, "pending")
    t.as_(u)
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'U', 5, 'x')", (hidden, u))
    t.fails("insert into claims (business_id, requester_id) values (%s, %s)", (hidden, u))


# ------------------------------------------------------------------- claims
@test
def claims_rules(t):
    o = t.user("o@x.co"); c = t.user("c@x.co"); b = t.business(o)
    t.as_(c)
    t.q("insert into claims (business_id, requester_id) values (%s, %s)", (b, c))
    t.fails("insert into claims (business_id, requester_id) values (%s, %s)", (b, c), contains="claims_one_pending_per_person")
    t.fails("insert into claims (business_id, requester_id, status) values (%s, %s, 'approved')", (b, c))
    t.as_(o)
    t.fails("insert into claims (business_id, requester_id) values (%s, %s)", (b, o))  # own listing
    t.as_(c)
    t.fails("update claims set status = 'approved'")


# ------------------------------------------------------------------ reviews
@test
def review_rules(t):
    o = t.user("o@x.co"); r = t.user("r@x.co"); b = t.business(o)
    t.as_(r)
    t.q("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'R', 4, 'good')", (b, r))
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'R', 4, 'again')", (b, r))
    t.as_(o)
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'O', 5, 'me')", (b, o))
    t.as_(t.user("z@x.co"))
    z = t.one("select auth.uid()")
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body, status) values (%s, %s, 'Z', 5, 'x', 'approved')", (b, z))
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body, owner_reply) values (%s, %s, 'Z', 5, 'x', 'fake reply')", (b, z))
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'Z', 9, 'x')", (b, z))
    t.fails("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, %s, 5, 'x')", (b, z, "n" * 81))


@test
def owner_reply_rules(t):
    o = t.user("o@x.co"); r = t.user("r@x.co"); x = t.user("x@x.co"); b = t.business(o)
    t.admin()
    rid = t.one("insert into reviews (business_id, author_id, author_name, rating, body, status) values (%s,%s,'R',2,'meh','approved') returning id", (b, r))
    t.as_(x)
    t.q("update reviews set owner_reply = 'not mine' where id = %s", (rid,))
    t.as_(o)
    t.fails("update reviews set rating = 5 where id = %s", (rid,))
    t.fails("update reviews set status = 'rejected' where id = %s", (rid,))
    t.q("update reviews set owner_reply = 'thanks' where id = %s", (rid,))
    t.admin()
    assert t.one("select owner_reply from reviews where id = %s", (rid,)) == "thanks"


# ------------------------------------------------------------ saved listings
@test
def saved_listings_are_private(t):
    a = t.user("a@x.co"); b2 = t.user("b@x.co"); biz = t.business(a)
    t.as_(a)
    t.q("insert into saved_listings (user_id, business_id) values (%s, %s)", (a, biz))
    t.fails("insert into saved_listings (user_id, business_id) values (%s, %s)", (b2, biz))
    t.as_(b2)
    assert t.q("select * from saved_listings") == []
    t.q("delete from saved_listings where user_id = %s", (a,))
    t.admin()
    assert t.one("select count(*) from saved_listings") == 1


# -------------------------------------------------------------------- admin
def team(t):
    mod = t.user("mod@x.co", mfa=True); vol = t.user("vol@x.co", mfa=True)
    t.admin()
    t.q("insert into admins (user_id, role) values (%s, 'moderator'), (%s, 'volunteer')", (mod, vol))
    return mod, vol


@test
def admin_needs_list_and_2fa(t):
    mod, vol = team(t)
    stranger = t.user("s@x.co", mfa=True)
    t.as_(vol, aal="aal1")
    t.fails("select admin_queue()", contains="not authorized")
    t.as_(stranger, aal="aal2")
    t.fails("select admin_queue()", contains="not authorized")
    t.as_(vol, aal="aal2")
    q = t.one("select admin_queue()")
    assert set(q) == {"new_listings", "edits", "claims", "reviews", "messages"}, q.keys()


@test
def admin_cannot_bypass_functions(t):
    mod, vol = team(t)
    o = t.user("o@x.co"); b = t.business(o, "pending")
    t.as_(mod, aal="aal2")
    t.fails("update businesses set status = 'approved' where id = %s", (b,))
    t.fails("select _apply_listing_fields(%s, '{}'::jsonb)", (b,))
    t.fails("select _require_admin()")


@test
def volunteer_vs_moderator_listing_powers(t):
    mod, vol = team(t)
    o = t.user("o@x.co"); p = t.business(o, "pending"); live = t.business(o, "approved")
    t.as_(vol, aal="aal2")
    t.q("select admin_set_listing_status(%s, 'approved')", (p,))
    t.fails("select admin_set_listing_status(%s, 'rejected')", (live,), contains="moderator")
    t.q("select admin_set_listing_flags(%s, '{halal,prayer}', false)", (live,))
    t.fails("select admin_set_listing_flags(%s, '{halal}', true)", (live,), contains="moderator")
    t.fails("select admin_set_listing_flags(%s, '{fake}', false)", (live,), contains="badge")
    t.q("select admin_set_listing_status(%s, 'approved')", (live,))  # no-op, allowed
    t.as_(mod, aal="aal2")
    t.q("select admin_set_listing_status(%s, 'rejected')", (live,))
    t.q("select admin_set_listing_flags(%s, '{halal}', true)", (live,))
    t.admin()
    assert t.q("select status, badges, featured from businesses where id = %s", (live,))[0] == ("rejected", ["halal"], True)
    assert t.one("select status from businesses where id = %s", (p,)) == "approved"


@test
def apply_and_reject_edits(t):
    mod, vol = team(t)
    o = t.user("o@x.co", mfa=False); b = t.business(o, "approved", "Old")
    t.as_(o); t.q("select owner_update_business(%s, '{\"name\":\"New\"}'::jsonb)", (b,))
    t.as_(vol, aal="aal2")
    q = t.one("select admin_queue()")
    assert q["edits"][0]["changes"] == {"name": "New"} and q["edits"][0]["live"]["name"] == "Old"
    assert "owner_id" not in q["edits"][0]["live"]
    t.q("select admin_apply_edit(%s)", (b,))
    t.admin()
    assert t.one("select name from businesses where id = %s", (b,)) == "New"
    assert t.one("select count(*) from business_edits") == 0
    t.as_(o); t.q("select owner_update_business(%s, '{\"name\":\"Bad\"}'::jsonb)", (b,))
    t.as_(vol, aal="aal2"); t.q("select admin_reject_edit(%s)", (b,))
    t.fails("select admin_apply_edit(%s)", (b,), contains="no pending edit")
    t.admin()
    assert t.one("select name from businesses where id = %s", (b,)) == "New"


@test
def claim_approval_transfers_ownership(t):
    mod, vol = team(t)
    o = t.user("o@x.co"); c = t.user("c@x.co"); b = t.business(o)
    t.as_(c); t.q("insert into claims (business_id, requester_id, note) values (%s, %s, 'mine')", (b, c))
    t.as_(vol, aal="aal2")
    q = t.one("select admin_queue()")
    claim = q["claims"][0]
    assert claim["requester_email"] == "c@x.co" and claim["current_owner_email"] == "o@x.co", claim
    t.q("select admin_resolve_claim(%s, true)", (claim["id"],))
    t.fails("select admin_resolve_claim(%s, true)", (claim["id"],), contains="already handled")
    t.admin()
    assert t.one("select owner_id from businesses where id = %s", (b,)) == c


@test
def review_moderation(t):
    mod, vol = team(t)
    o = t.user("o@x.co"); r = t.user("r@x.co"); b = t.business(o)
    t.as_(r); t.q("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'R', 5, 'great')", (b, r))
    t.as_(vol, aal="aal2")
    rid = t.one("select admin_queue()")["reviews"][0]["id"]
    t.fails("select admin_set_review_status(%s, 'pending')", (rid,))
    t.q("select admin_set_review_status(%s, 'approved')", (rid,))
    t.as_()
    assert t.one("select count(*) from reviews") == 1


@test
def new_listing_queue_shows_halal_and_owner(t):
    mod, vol = team(t)
    o = t.user("o@x.co")
    t.as_(o)
    t.q("insert into businesses (owner_id, name, category, neighborhood, description, long_description, halal_status)"
        " values (%s, 'Q', 'Restaurants', 'Dublin', 's', 'l', 'certified')", (o,))
    t.as_(vol, aal="aal2")
    item = [x for x in t.one("select admin_queue()")["new_listings"] if x["name"] == "Q"][0]
    assert item["halal_status"] == "certified" and item["owner_email"] == "o@x.co", item


@test
def team_management(t):
    mod, vol = team(t)
    newbie = t.user("new@x.co")
    t.as_(vol, aal="aal2")
    t.fails("select admin_team()", contains="moderator")
    t.fails("select admin_add_member('new@x.co', 'volunteer')", contains="moderator")
    t.as_(mod, aal="aal2")
    assert len(t.one("select admin_team()")) == 2
    t.fails("select admin_add_member('nobody@x.co', 'volunteer')", contains="no account")
    t.q("select admin_add_member('NEW@x.co', 'volunteer')")
    t.fails("select admin_add_member('new@x.co', 'moderator')", contains="already")
    t.fails("select admin_add_member('new@x.co', 'owner')", contains="role")
    t.fails("select admin_set_member_role(%s, 'volunteer')", (mod,), contains="at least one moderator")
    t.fails("select admin_remove_member(%s)", (mod,), contains="at least one moderator")
    t.admin()
    assert t.one("select added_by from admins where user_id = %s", (newbie,)) == mod
    t.as_(mod, aal="aal2")
    t.q("select admin_set_member_role(%s, 'moderator')", (vol,))
    t.q("select admin_set_member_role(%s, 'volunteer')", (mod,))  # now allowed: vol is a moderator
    t.fails("select admin_remove_member(%s)", (newbie,), contains="moderator")  # mod just demoted themselves
    t.as_(vol, aal="aal2")
    t.q("select admin_remove_member(%s)", (newbie,))
    t.admin()
    assert t.one("select count(*) from admins") == 2


@test
def admins_table_is_not_self_service(t):
    mod, vol = team(t)
    x = t.user("x@x.co", mfa=True)
    t.as_(x, aal="aal2")
    t.fails("insert into admins (user_id, role) values (%s, 'moderator')", (x,))
    t.as_(vol, aal="aal2")
    # Row security silently filters writes it doesn't allow, so check the effect.
    t.q("update admins set role = 'moderator' where user_id = %s", (vol,))
    t.q("delete from admins where user_id = %s", (mod,))
    assert [r[0] for r in t.q("select user_id from admins")] == [vol]  # sees only own row
    t.admin()
    assert t.one("select role from admins where user_id = %s", (vol,)) == "volunteer", "volunteer promoted themselves!"
    assert t.one("select count(*) from admins") == 2, "volunteer removed the moderator!"


# ------------------------------------------------------------------- alerts
@test
def alerts_fire_for_new_things(t):
    o = t.user("o@x.co"); r = t.user("r@x.co"); b = t.business(o)
    t.admin(); t.q("delete from net.requests")
    t.as_(o)
    t.q("insert into businesses (owner_id, name, category, neighborhood, description, long_description) values (%s,'N','R','D','s','l')", (o,))
    t.as_(r)
    t.q("insert into claims (business_id, requester_id) values (%s, %s)", (b, r))
    t.q("insert into reviews (business_id, author_id, author_name, rating, body) values (%s, %s, 'R', 3, 'ok')", (b, r))
    t.as_(role="service_role")
    t.q("insert into contact_messages (name, email, message) values ('a', 'a@b.co', 'hi')")
    t.admin()
    reqs = t.q("select url, body ->> 'type', body ->> 'table', headers ->> 'Authorization' from net.requests order by id")
    tables = [x[2] for x in reqs]
    assert tables == ["businesses", "claims", "reviews", "contact_messages"], reqs
    assert all(x[0] == "https://nicc-business.vercel.app/api/notify" and x[1] == "INSERT" and x[3] == "Bearer " + SECRET for x in reqs), reqs


# ----------------------------------------------------------- contact/storage
@test
def contact_messages_server_only(t):
    t.as_()
    t.fails("insert into contact_messages (name, email, message) values ('a','a@b.co','x')")
    u = t.user("u@x.co"); t.as_(u)
    t.fails("insert into contact_messages (name, email, message) values ('a','a@b.co','x')")
    t.as_(role="service_role")
    t.q("insert into contact_messages (name, email, message, ip_hash) values ('a','a@b.co','x','h')")
    t.fails("insert into contact_messages (name, email, message) values (%s,'a@b.co','x')", ("n" * 121,))


@test
def photo_storage_only_into_own_folder(t):
    o = t.user("o@x.co"); x = t.user("x@x.co"); b = t.business(o)
    t.as_(o)
    t.q("insert into storage.objects (bucket_id, name) values ('business-photos', %s)", ("%s/1.jpg" % b,))
    t.as_(x)
    t.fails("insert into storage.objects (bucket_id, name) values ('business-photos', %s)", ("%s/2.jpg" % b,))
    t.as_()
    t.fails("insert into storage.objects (bucket_id, name) values ('business-photos', %s)", ("%s/3.jpg" % b,))


@test
def rate_limit_new_listings(t):
    o = t.user("o@x.co")
    t.as_(o)
    for i in range(3):
        t.q("insert into businesses (owner_id, name, category, neighborhood, description, long_description) values (%s,%s,'R','D','s','l')", (o, "b%d" % i))
    t.fails("insert into businesses (owner_id, name, category, neighborhood, description, long_description) values (%s,'b4','R','D','s','l')", (o,), contains="too many")


# --------------------------------------------------------------------- main
def main():
    conn = setup()
    conn.autocommit = False
    t = Ctx(conn)
    failed = 0
    for fn in TESTS:
        try:
            fn(t)
            print("  ok    " + fn.__name__)
        except Exception:
            failed += 1
            print("  FAIL  " + fn.__name__)
            traceback.print_exc(limit=1)
        finally:
            conn.rollback()
    print("%d passed, %d failed" % (len(TESTS) - failed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
