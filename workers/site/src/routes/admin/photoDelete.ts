import type { Context } from "hono";
import { getFoodbankBySlug, getOwnedPhoto, deletePlacePhoto, clearPlaceHasPhoto } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";

// gfadmin/views.py:1877-1913 photo_delete, registered
// gfadmin/urls/foodbanks.py:24. @require_POST in Django too -- this is the
// one delete in gfadmin that was already POST-only, unlike its
// donationpoint_delete sibling (PLAN.md:10047 flags that one's delete-on-GET
// as a defect this port fixes). So: POST only here as well, never a GET.
//
// WHAT THIS BUTTON ACTUALLY DOES, documented rather than copied. In Django
// it is a CACHE BUST, not a delete: photo.delete() (views.py:1908) leaves
// place_has_photo = 1 on the owning row, gfwfbn/views.py:501-504 gates the
// public photo route on that flag, and givefood/utils/geo.py:107-141 catches
// the resulting DoesNotExist by re-fetching from Google Places (two billed
// calls) and re-inserting an identical row. The photo is back on the next
// request.
//
// This port additionally clears place_has_photo. That only makes it a real
// delete once the media-backfill queue consumer honours the flag --
// serveMedia (routes/media.ts:58-64) enqueues a backfill on ANY R2 miss with
// no such check, and workers/jobs/src/queues/jobs.ts:60 doesn't handle
// photo.jpg keys yet at all. Until both halves exist this is still a
// refresh, and the UI copy in foodbank_tabs/photos.njk says "refresh", not
// "delete".
export async function adminPhotoDelete(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const photoId = Number(c.req.param("photoId"));
  if (!Number.isInteger(photoId)) return c.notFound();

  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, slug); // views.py:1880 get_object_or_404
  if (!foodbank) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  // views.py:1883-1906's ownership check -- the whole point of the view.
  // A null answer covers BOTH Django's 404 (no such photo, views.py:1881)
  // and its 403 (someone else's photo, views.py:1906); see getOwnedPhoto's
  // own comment on why collapsing those two is deliberate.
  const photo = await getOwnedPhoto(db, foodbank.id, photoId);
  if (!photo) return c.notFound();

  // ONE R2 object per photo URL: media.ts:44 keys on "media" + url.pathname
  // and normalises ?size= away (media.ts:40-43), so there is no derivative
  // to chase today. PLAN.md:10586 anticipates 320/640/1080 derivatives being
  // generated at ingest -- if the backfill consumer starts writing them it
  // must publish their key shape and this line must delete those too. Not
  // guessing a naming scheme here.
  await c.env.MEDIA.delete(photo.r2_key);
  await deletePlacePhoto(db, photo.id);
  await clearPlaceHasPhoto(db, photo.owner_table, photo.place_id);

  // views.py:1911-1913 -- htmx gets an empty 200 so hx-swap="delete" removes
  // the row; a plain form post gets the redirect to the detail page.
  if (c.req.header("HX-Request")) return c.body(null, 200);
  return c.redirect(`/admin/foodbank/${slug}/`, 302);
}
