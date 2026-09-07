import { describe, expect, it } from "vitest";
import { parseCookie } from "./cookies";

// parseCookie is the single door through which BOTH security-critical cookies
// on this site are read: lib/csrf.ts reads `__Host-csrf` and lib/adminAuth.ts
// reads `__Host-gfsession` and `__Host-oauth`. Everything downstream of it
// fails closed on a null -- getAdminSession() returns null (signed out),
// verifyCsrf() returns false (403), handleGoogleOAuthCallback() bounces back
// to /auth/. So the failure this file guards against is not a crash, it is a
// silent misread: returning the wrong string, or null for a cookie that is
// genuinely present, turns into "you are logged out" or "403 on Save" with no
// error anywhere to point at the cause.
//
// The other half is the mirror image: it must NOT return a value the browser
// did not actually send under that exact name. Both consumers treat whatever
// comes back as the authoritative cookie for a signed value, so a loose match
// is a cookie-shadowing bug, not a cosmetic one.
//
// Note on ancestry: unlike most of workers/site/src/lib, this has no Django
// original -- Django never hand-parsed a Cookie header, it read
// request.COOKIES, populated by django.http.cookie.parse_cookie(). Several
// tests below pin places where this deliberately-smaller function behaves
// differently from that function, so a future "make it match Django" change
// has to be a decision rather than an accident.
//
// A note on how these tests are chosen: the function is eleven lines, so the
// risk is not that today's version is wrong, it is that a future rewrite
// looks equivalent and is not. Each test below is aimed at a specific
// plausible wrong version -- split("=") instead of indexOf, startsWith
// instead of ===, a regex, a parse-into-an-object refactor, lastIndexOf,
// last-match-wins, a comma-aware splitter, decodeURIComponent "for safety".
// A test that no wrong version would fail is not worth its lines.

describe("parseCookie", () => {
  it("pulls one named cookie out of a real browser Cookie header", () => {
    // The shape a browser actually sends: NAME=VALUE pairs joined by "; ".
    // Both live cookie values are `<payload>.<hmac>` (csrf.ts line 76,
    // adminAuth.ts signOAuthCookie), so the dot-separated value must come
    // back whole -- verifyCsrf() splits it itself at the first dot.
    //
    // The mixed case in these values is load-bearing too: an implementation
    // that lowercased the header to make name matching easier would still
    // pass a name-only assertion, but would hand verifyCsrf() a mangled hex
    // signature that never verifies.
    const header = "__Host-gfsession=8Kq2Vw; __Host-csrf=deadbeef.0a1b2c; _ga=GA1.1.99";
    expect(parseCookie(header, "__Host-csrf")).toBe("deadbeef.0a1b2c");
    expect(parseCookie(header, "__Host-gfsession")).toBe("8Kq2Vw");
    expect(parseCookie(header, "_ga")).toBe("GA1.1.99");
  });

  it("reads the first, middle and last cookie in the header equally well", () => {
    // Cookie ordering is entirely the browser's business and changes as
    // cookies are re-set, so no consumer may depend on position. An
    // off-by-one in the scan would typically only lose the last one.
    const header = "a=1; b=2; c=3";
    expect([parseCookie(header, "a"), parseCookie(header, "b"), parseCookie(header, "c")]).toEqual(["1", "2", "3"]);
  });

  it("returns null for an absent, empty or null Cookie header", () => {
    // hono's c.req.header("Cookie") returns undefined for an absent header --
    // this is the first request from a brand new visitor, and by far the most
    // common call. Must not throw on undefined before anything else works.
    expect(parseCookie(undefined, "__Host-gfsession")).toBeNull();
    // An empty string reaches the same answer. Note this one is NOT proof
    // that the `!cookieHeader` guard exists: "".split(";") is [""], which has
    // no "=" and is skipped anyway. The guard is only observable on null --
    // hence the next assertion, which is the one that would actually fail if
    // the guard were narrowed to `=== undefined`.
    expect(parseCookie("", "__Host-gfsession")).toBeNull();
    // null is a real input, not a hypothetical: the declared type is
    // `string | undefined` because hono's header() returns that, but
    // Request.headers.get("Cookie") -- the plain Workers API any future
    // caller might reach for -- returns `string | null`. One such caller and
    // a `=== undefined` guard turns into "Cannot read properties of null" on
    // every request from a cookieless visitor. The cast is deliberate: it is
    // exactly the shape of the mistake being guarded against.
    expect(parseCookie(null as unknown as undefined, "__Host-gfsession")).toBeNull();
  });

  it("returns null when the header exists but does not contain that cookie", () => {
    // The signed-out-but-has-analytics-cookies case: a session cookie must
    // not be conjured out of a header full of other people's cookies.
    expect(parseCookie("_ga=GA1.1.99; cf_clearance=abc", "__Host-gfsession")).toBeNull();
  });

  it("returns null -- not a Function -- for names that exist on Object.prototype", () => {
    // Aimed squarely at the most likely refactor of this function: "parse the
    // header once into an object and look the name up". Written as a plain
    // `{}` map, `cookies[name]` for name "constructor" or "toString" returns
    // an inherited Function, which is truthy, so getAdminSession() would sail
    // past `if (!sessionId)` and hand a Function to KV, and issueCsrfToken()
    // would call .indexOf on it. The linear scan here is immune by
    // construction, and this pins that immunity so the refactor has to use a
    // Map or a null-prototype object to stay green.
    for (const inherited of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
      expect(parseCookie("a=1; b=2", inherited)).toBeNull();
    }
    // And when such a name really is in the jar, it is returned as the plain
    // string it is -- no prototype involved either way.
    expect(parseCookie("__proto__=planted; a=1", "__proto__")).toBe("planted");
  });

  it("splits on the FIRST '=' only, so a value containing '=' survives intact", () => {
    // Today's values are hex and unpadded base64url (adminAuth.ts strips the
    // "=" padding in base64UrlEncode), so this is a latent-bug guard rather
    // than a live path: the day any cookie here carries padded base64 or a
    // percent-free query-ish payload, a naive split("=") would truncate the
    // value, the HMAC would not verify, and the user would just get a 403
    // with nothing logged. Pin it before that happens.
    expect(parseCookie("__Host-oauth=eyJhIjoxfQ==.9f8e", "__Host-oauth")).toBe("eyJhIjoxfQ==.9f8e");
    expect(parseCookie("token=a=b=c", "token")).toBe("a=b=c");
    // The same rule seen from the name side, which is what catches a
    // lastIndexOf("=") implementation: with lastIndexOf, "a=b=c" parses as
    // the name "a=b", and this lookup would wrongly succeed with "c".
    expect(parseCookie("a=b=c", "a=b")).toBeNull();
  });

  it("trims the optional whitespace browsers put after each ';'", () => {
    // RFC 6265 sends "; " between pairs but the space is optional and some
    // clients/proxies use none, a tab, or several. All four must parse the
    // same, otherwise the name comparison fails on the leading space and an
    // admin appears signed out depending on which client they used.
    expect(parseCookie("a=1;__Host-csrf=tok.sig", "__Host-csrf")).toBe("tok.sig");
    expect(parseCookie("a=1;   __Host-csrf=tok.sig", "__Host-csrf")).toBe("tok.sig");
    expect(parseCookie("a=1;\t__Host-csrf=tok.sig", "__Host-csrf")).toBe("tok.sig");
    // The VALUE is trimmed with the same String.prototype.trim, so it strips
    // tabs and newlines too, not just spaces. Asserted separately because a
    // hand-rolled trim (/^ +| +$/) would pass the space case above and then
    // leave a tab glued to a signature, which fails the HMAC compare in
    // verifyCsrf() with no clue as to why.
    expect(parseCookie("a=1; __Host-csrf=\ttok.sig\t", "__Host-csrf")).toBe("tok.sig");
    expect(parseCookie("a=1; __Host-csrf=\ntok.sig\n", "__Host-csrf")).toBe("tok.sig");
    // Whitespace is trimmed off the VALUE's edges too, but only the edges --
    // an internal space is part of the value and is preserved.
    expect(parseCookie("note= hello world ; a=1", "note")).toBe("hello world");
  });

  it("compares the requested name byte-for-byte, without trimming it", () => {
    // Only the header side is trimmed; the caller's `name` is used exactly as
    // passed. All three live callers pass a module constant so this never
    // bites today, but it is the asymmetry a "trim both sides for symmetry"
    // tidy-up would remove -- and that change would let a caller with a
    // stray space match, which is the wrong direction for a security lookup.
    expect(parseCookie("a=1", " a")).toBeNull();
    expect(parseCookie("a=1", "a ")).toBeNull();
    expect(parseCookie("a=1", "a")).toBe("1");
  });

  it("matches the cookie name case-sensitively", () => {
    // This one is genuinely load-bearing, not pedantry. Cookie names are
    // case-sensitive per RFC 6265, and the browser's `__Host-` prefix rules
    // (Secure + Path=/ + no Domain, so a sibling subdomain cannot set it) are
    // matched case-sensitively too. `__host-csrf` in lowercase gets NO prefix
    // protection, so an attacker on a sibling subdomain can set one. A
    // case-insensitive match here -- an easy thing to add while "fixing" a
    // header-name-casing bug elsewhere -- would let that planted cookie be
    // read as the real `__Host-csrf`.
    expect(parseCookie("__host-csrf=planted.bysubdomain", "__Host-csrf")).toBeNull();
    expect(parseCookie("__HOST-GFSESSION=planted", "__Host-gfsession")).toBeNull();
    // Belt and braces: with the lowercase decoy sitting first, the correctly
    // cased cookie is still the one returned, so a case-insensitive scan
    // cannot hide behind "it found the right one anyway".
    expect(parseCookie("__host-csrf=planted; __Host-csrf=real.sig", "__Host-csrf")).toBe("real.sig");
  });

  it("matches the whole name, never a prefix, suffix or substring of it", () => {
    // Any cookie may be set on this domain by anything the site loads. A
    // startsWith()/includes() implementation would hand `__Host-csrfAAA`
    // back as the CSRF cookie and every Save would 403 -- or worse, accept an
    // attacker-chosen value.
    expect(parseCookie("__Host-csrfEXTRA=nope", "__Host-csrf")).toBeNull();
    expect(parseCookie("x__Host-csrf=nope", "__Host-csrf")).toBeNull();
    expect(parseCookie("csrf=nope", "__Host-csrf")).toBeNull();
    // And with a decoy sitting immediately before the genuine cookie, the
    // genuine one still wins.
    expect(parseCookie("__Host-csrfEXTRA=nope; __Host-csrf=real.sig", "__Host-csrf")).toBe("real.sig");
  });

  it("will not let a cookie's VALUE masquerade as a cookie name", () => {
    // The obvious attack on a sloppy parser: set a cookie whose value spells
    // out "__Host-csrf=<attacker token>" and hope an indexOf-over-the-whole-
    // header implementation finds it. Splitting on ";" first means the name
    // is only ever read from the start of a pair.
    const header = "decoy=__Host-csrf=planted; __Host-csrf=genuine.sig";
    expect(parseCookie(header, "__Host-csrf")).toBe("genuine.sig");
    // Same header, and the decoy still reads as its own cookie with the whole
    // thing as its value -- nothing was consumed out from under it.
    expect(parseCookie(header, "decoy")).toBe("__Host-csrf=planted");
  });

  it("compares names literally, so no name is ever treated as a pattern", () => {
    // Guards against a future rewrite into `new RegExp(name + "=")`: "." in a
    // regex matches any character, so `a.b` would match `axb`. Nothing in the
    // live cookie names contains a regex metacharacter today, which is
    // exactly why such a rewrite would look harmless in review.
    expect(parseCookie("axb=wrong", "a.b")).toBeNull();
    expect(parseCookie("axb=wrong; a.b=right", "a.b")).toBe("right");
  });

  it("treats ';' as the only separator -- a comma is data, not a delimiter", () => {
    // Python's http.cookies.SimpleCookie (and several JS cookie libraries,
    // which try to be helpful about the comma-joined Set-Cookie form) will
    // split on "," as well. Django's parse_cookie does not, and neither does
    // this. It matters because the comma is a legal cookie-octet: a
    // comma-aware splitter would silently truncate any value containing one,
    // which fails the HMAC compare rather than erroring anywhere useful.
    expect(parseCookie("a=1,b=2", "a")).toBe("1,b=2");
    // ...and the text after the comma is emphatically NOT a second cookie.
    expect(parseCookie("a=1,b=2", "b")).toBeNull();
    // The flip side of the same rule, and the parser's real limitation: a
    // ";" inside a value truncates it, because the split happens first.
    // That is correct -- ";" is not a legal cookie-octet, so a browser can
    // never send one -- but it is worth pinning as a known boundary.
    expect(parseCookie("a=x;y; b=2", "a")).toBe("x");
    expect(parseCookie("a=x;y; b=2", "b")).toBe("2");
  });

  it("skips a chunk with no '=' and carries on scanning", () => {
    // A malformed or flag-style chunk anywhere in the header must not abort
    // the scan and take the session cookie down with it -- a `continue`, not
    // a `break` or a throw. This is also a deliberate divergence from
    // Django's parse_cookie(), which stores such a chunk under the empty
    // name ("" -> chunk) rather than dropping it; nothing here ever looks up
    // the empty name, so dropping it is the simpler equivalent.
    expect(parseCookie("junk; __Host-gfsession=abc", "__Host-gfsession")).toBe("abc");
    expect(parseCookie("__Host-gfsession=abc; junk", "__Host-gfsession")).toBe("abc");
    expect(parseCookie("a=1; junk; b=2", "b")).toBe("2");
    // ...and asking for such a chunk by its text finds nothing, because it
    // was never indexed under any name.
    expect(parseCookie("junk; a=1", "junk")).toBeNull();
    // Empty chunks from a doubled or trailing separator are the same case
    // and must not end the scan either. Trailing ";" is common from
    // hand-built headers and from proxies that re-join a cookie jar.
    expect(parseCookie("a=1;;b=2", "b")).toBe("2");
    expect(parseCookie("a=1; ", "a")).toBe("1");
  });

  it("returns an empty string -- not null -- for a present-but-empty cookie", () => {
    // Both logout paths clear their cookie by re-setting it empty
    // (adminAuth.ts revokeAdminSession / clearOAuthCookie:
    // "__Host-gfsession=; ... Max-Age=0"). A browser that echoes an empty
    // value back before honouring Max-Age must read as SIGNED OUT. Every
    // consumer tests falsiness (`if (!sessionId)`, `if (!cookieValue)`), so
    // "" is safe -- but a consumer written as `!== null` would treat a
    // cleared session as a live one. This test is the reason that
    // distinction is documented rather than assumed.
    expect(parseCookie("__Host-gfsession=", "__Host-gfsession")).toBe("");
    expect(parseCookie("__Host-gfsession=   ; a=1", "__Host-gfsession")).toBe("");
    // Stated as the property consumers actually rely on: falsy, so every
    // `if (!x)` guard treats a cleared cookie as absent...
    expect(parseCookie("__Host-gfsession=", "__Host-gfsession")).toBeFalsy();
    // ...and distinct from the absent case for anyone who needs to tell
    // "cleared" from "never set". Asserted as a type, not just a value,
    // because `toBe("")` alone would also pass for a stray `undefined`.
    expect(typeof parseCookie("__Host-gfsession=", "__Host-gfsession")).toBe("string");
    expect(parseCookie("a=1", "__Host-gfsession")).toBeNull();
  });

  it("returns the FIRST match when a name appears twice, even if it is empty", () => {
    // Current behaviour, pinned deliberately: the scan returns on first hit.
    // Django's parse_cookie() builds a dict and so keeps the LAST one, and
    // browsers send the more-path-specific cookie first (RFC 6265 5.4), so
    // this picks the more specific and Django picked the less specific.
    // In practice duplicates cannot arise for the three cookies read here:
    // the `__Host-` prefix forces Path=/ and forbids Domain, so a second
    // cookie of the same name cannot exist. If a non-__Host- cookie is ever
    // read through this function, that is when this difference starts to
    // matter.
    expect(parseCookie("dupe=first; dupe=second", "dupe")).toBe("first");
    // The sharp version of "first", and the one an ordinary duplicates test
    // misses: first wins even when the first value is EMPTY. Any
    // implementation that accumulates with `found = found || value`, or
    // filters for a truthy match, would skip the empty one and return
    // "second" -- which in the logout scenario above means resurrecting a
    // stale session cookie the user just cleared. Failing closed requires
    // that the empty one is what comes back.
    expect(parseCookie("__Host-gfsession=; __Host-gfsession=stale", "__Host-gfsession")).toBe("");
    expect(parseCookie("__Host-gfsession=   ; __Host-gfsession=stale", "__Host-gfsession")).toBe("");
  });

  it("does not decode, unquote or otherwise transform the value", () => {
    // Two separate claims, because they have different ancestries.
    //
    // (1) No URL-decoding. Django's parse_cookie does not percent-decode
    // either, so this is not a divergence -- it is pinned because
    // decodeURIComponent() is the obvious thing to add "for safety", and it
    // would break verifyCsrf()'s byte-compare of the cookie against the form
    // field for any value containing a literal '%'. (It would also throw on
    // a malformed sequence like "%zz", turning a junk cookie into a 500.)
    expect(parseCookie("next=%2Fadmin%2Ffoodbank%2F", "next")).toBe("%2Fadmin%2Ffoodbank%2F");
    expect(parseCookie("bad=100%", "bad")).toBe("100%");
    expect(parseCookie("plus=a+b", "plus")).toBe("a+b");
    // (2) No unquoting -- this IS the divergence from Django. Django's
    // parse_cookie() runs http.cookies._unquote() over every value, which
    // strips a surrounding pair of double quotes (and unescapes \\ octal
    // sequences inside them), so Django would report `wrapped` here where
    // this reports `"wrapped"` with the quotes on. Correct for this site's
    // values (hex and base64url never need quoting) and required for the
    // byte-compare, but a real difference if this is ever reused.
    expect(parseCookie('quoted="wrapped"', "quoted")).toBe('"wrapped"');
    expect(parseCookie('esc="a\\073b"', "esc")).toBe('"a\\073b"');
  });

  it("compares non-ASCII names by code unit, with no Unicode normalisation", () => {
    // Two things at once. First, values are sliced by UTF-16 index, so a
    // multi-byte character comes back whole -- a rewrite that indexed into a
    // TextEncoder byte array would cut an accented character or an emoji in
    // half and produce mojibake instead of a clean miss.
    expect(parseCookie("accent=résumé; a=1", "accent")).toBe("résumé");
    expect(parseCookie("emoji=a\u{1F36A}b; a=1", "emoji")).toBe("a\u{1F36A}b");
    // Second, `===` on strings is a code-unit comparison: the composed form
    // of "café" (U+00E9) and the decomposed form (e + U+0301) look identical
    // on screen and do not match each other. Pinned so that adding
    // .normalize() or localeCompare() -- both of which WOULD match these --
    // is a conscious change rather than a stray "make comparison robust"
    // edit. Cookie names are byte strings; making them locale-aware would be
    // a new and surprising matching rule in a security lookup.
    const composed = "café";
    const decomposed = "café";
    expect(parseCookie(`${composed}=x`, composed)).toBe("x");
    expect(parseCookie(`${decomposed}=x`, composed)).toBeNull();
    expect(parseCookie(`${composed}=x`, decomposed)).toBeNull();
  });

  it("survives malformed and adversarial headers without throwing", () => {
    // A Cookie header is attacker-influenced input on every request. There is
    // no try/catch at any call site -- getAdminSession() and verifyCsrf() call
    // straight in -- so a throw here is a 500 on every admin page for anyone
    // holding a junk cookie jar.
    const nasty = [";", ";;;", "=", "=;=;=", "   ", "\t\n", "a=", "=a", "; ; a=1 ;", " = "];
    for (const header of nasty) {
      expect(() => parseCookie(header, "__Host-csrf")).not.toThrow();
      expect(parseCookie(header, "__Host-csrf")).toBeNull();
    }
    // A very long single value must not be truncated or blow up either --
    // 8KB is roughly a real browser's per-cookie ceiling.
    const long = "x".repeat(8 * 1024);
    expect(parseCookie(`big=${long}; a=1`, "big")).toBe(long);
    // Nor may a large jar be partially scanned. Browsers happily send 50+
    // cookies on a domain that has run analytics and consent tools for
    // years, and the site's own cookie is not guaranteed to be near the
    // front. This would fail against `split(";", 10)` -- JS's second
    // argument is a result limit, not Python's maxsplit, and that mix-up is
    // exactly the sort a Django-to-Workers port invites.
    const jar = Array.from({ length: 60 }, (_, i) => `c${i}=v${i}`)
      .concat("__Host-csrf=real.sig")
      .join("; ");
    expect(parseCookie(jar, "__Host-csrf")).toBe("real.sig");
    // And nothing is sanitised on the way out: a value carrying CRLF comes
    // back with it intact, because trim() only touches the ends. That is the
    // contract callers must know about -- csrf.ts only ever echoes a value
    // into HTML after its HMAC verifies, so a planted value like this one
    // cannot reach the page. If that ordering is ever relaxed, this
    // assertion is the reminder that parseCookie is not the escaping layer.
    expect(parseCookie("a=x\r\nSet-Cookie: evil=1", "a")).toBe("x\r\nSet-Cookie: evil=1");
  });

  it("handles a nameless '=value' chunk as the empty-name cookie", () => {
    // Documenting, not endorsing: no caller passes "" as the name, but the
    // trim-and-compare finds one if asked. Recorded so the behaviour is a
    // known quantity rather than a surprise if this is ever reused.
    expect(parseCookie("=orphan; a=1", "")).toBe("orphan");
    expect(parseCookie("a=1; b=2", "")).toBeNull();
  });

  it("reads all three of the site's own cookies out of one realistic header", () => {
    // The integration shape: an admin mid-sign-in has the OAuth cookie, the
    // session cookie and the CSRF cookie in flight simultaneously, mixed in
    // with Cloudflare's and Google Analytics' own. csrf.ts and adminAuth.ts
    // each call parseCookie against this same header independently, so all
    // three lookups must be correct at once.
    const header = [
      "_ga=GA1.1.1234567.7654321",
      "__Host-oauth=eyJzdGF0ZSI6ImFiYyJ9.4f3e2d1c",
      "cf_clearance=Xy.Zz-01",
      "__Host-gfsession=nJ8vQ2r5T7wA",
      "__Host-csrf=1a2b3c4d5e6f.aabbccdd",
    ].join("; ");
    expect(parseCookie(header, "__Host-oauth")).toBe("eyJzdGF0ZSI6ImFiYyJ9.4f3e2d1c");
    expect(parseCookie(header, "__Host-gfsession")).toBe("nJ8vQ2r5T7wA");
    expect(parseCookie(header, "__Host-csrf")).toBe("1a2b3c4d5e6f.aabbccdd");
    // And a cookie name this site has never set is still absent from it.
    expect(parseCookie(header, "__Host-admin")).toBeNull();
    // The values are exactly what the two consumers then take apart at the
    // first dot -- asserted here as the round trip they actually perform, so
    // that a change to parseCookie which mangled a payload (a stray decode,
    // a lost character) shows up as a broken session rather than as a
    // slightly different string in an assertion above.
    const session = parseCookie(header, "__Host-oauth") as string;
    const dot = session.indexOf(".");
    expect(session.slice(0, dot)).toBe("eyJzdGF0ZSI6ImFiYyJ9");
    expect(session.slice(dot + 1)).toBe("4f3e2d1c");
  });
});
