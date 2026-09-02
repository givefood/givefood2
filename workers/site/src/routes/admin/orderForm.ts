import type { Context } from "hono";
import {
  deliveryDatetime,
  findConflictingOrder,
  getFoodbankBySlug,
  getFoodbankOptionById,
  getNeedOptionsForFoodbank,
  getOpenFoodbankOptions,
  getOrderForEdit,
  getOrderGroupOptions,
  insertAdminJob,
  recomputeFoodbankLastOrder,
  setOrderId,
  slugifyProvider,
  upsertOrder,
  type FoodbankOptionRow,
  type OrderEditRow,
  type Session,
} from "@givefood/db";
import { djangoDate, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:455-491 order_form + givefood/forms.py:189-210
// OrderForm -- one handler for both /admin/order/new/ and
// /admin/order/:orderId/edit/, same shape as adminDonationPointForm.
//
// The AI half of Django's Order.save() (models/orders.py:130-216: one
// Gemini JSON call to parse items_text into order lines, plus up to one
// more per never-before-seen item name to categorise it) does NOT run
// here. This handler validates, writes the `orders` row with zeroed
// aggregates, and enqueues an "order-lines" admin_job that workers/jobs
// picks up -- GEMINI_API_KEY is bound only to that Worker (PLAN.md 3.1's
// secret blast-radius split), and 1+N sequential paid AI calls do not
// belong in a request the admin's browser is holding open. See
// packages/db/src/orderWrite.ts's header for the full split.
//
// Django accepts GET and POST on one view and selects the save branch with
// `if request.POST:` -- the truthiness of a QueryDict, so a genuinely
// EMPTY POST body silently re-renders the form instead of saving or
// erroring. Not ported: Hono routes the two methods explicitly.

const DELIVERY_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]; // givefood/const/general.py:1
const DELIVERY_PROVIDERS = ["Tesco", "Sainsbury's", "Costco", "Pedal Me"]; // givefood/const/general.py:15-20
const NEED_OPTION_LIMIT = 200; // see getNeedOptionsForFoodbank's own note

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// A real calendar date, not just the right shape: "2026-02-31" matches the
// regex but is not a date, and Django's DateField rejects it.
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formValue(body: Record<string, unknown>, key: string): string {
  const raw = body[key];
  return typeof raw === "string" ? raw.trim() : "";
}

// FoodbankChange.__str__ (givefood/models/needs.py:84-85):
//   "%s - %s (%s)" % (foodbank_name, created.strftime("%b %d %Y %H:%M:%S"),
//                     str(need_id)[:7])
// %d and %H are ZERO-padded in Python, so the equivalent Django date
// format string is "M d Y H:i:s" -- not "M j Y G:i:s", which would drop
// the padding.
function needOptionLabel(need: { foodbank_name: string | null; created: string; need_id: string }): string {
  return `${need.foodbank_name ?? "None"} - ${djangoDate(need.created, "M d Y H:i:s")} (${need.need_id.slice(0, 7)})`;
}

interface OrderFormData {
  foodbank_id: number | null;
  items_text: string;
  need_id: number | null;
  order_group_id: number | null;
  source_url: string | null;
  delivery_date: string;
  delivery_hour: number | null;
  delivery_provider: string | null;
  delivery_provider_id: string | null;
  actual_cost: number | null;
}

const EMPTY_FORM_DATA: OrderFormData = {
  foodbank_id: null,
  items_text: "",
  need_id: null,
  order_group_id: null,
  source_url: null,
  delivery_date: "",
  delivery_hour: null,
  delivery_provider: null,
  delivery_provider_id: null,
  actual_cost: null,
};

export async function adminOrderForm(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const orderId = c.req.param("orderId");

  const order = orderId ? await getOrderForEdit(db, orderId) : null;
  if (orderId && !order) return c.notFound();

  // views.py:459-461 uses Foodbank.objects.get(slug=...), which raises
  // DoesNotExist -> HTTP 500 for an unknown ?foodbank= slug. 404 here
  // instead -- a fix, not a port.
  const foodbankSlug = c.req.query("foodbank");
  const preselected = foodbankSlug ? await getFoodbankBySlug(db, foodbankSlug) : null;
  if (foodbankSlug && !preselected) return c.notFound();

  if (c.req.method === "POST") return handlePost(c, db, order);

  const data: OrderFormData = order
    ? {
        foodbank_id: order.foodbank_id,
        items_text: order.items_text,
        need_id: order.need_id,
        order_group_id: order.order_group_id,
        source_url: order.source_url,
        delivery_date: order.delivery_date,
        delivery_hour: order.delivery_hour,
        delivery_provider: order.delivery_provider,
        delivery_provider_id: order.delivery_provider_id,
        actual_cost: order.actual_cost,
      }
    : // forms.py:207-208 -- BoundField.value() falls back to `initial`, so
      // ?foodbank=<slug> preselects the food bank AND narrows the `need`
      // queryset to that food bank's needs. (forms.py:201-206 tries to do
      // the same thing and is dead code: 207-210 overwrite it
      // unconditionally two lines later.)
      { ...EMPTY_FORM_DATA, foodbank_id: preselected?.id ?? null };

  return renderForm(c, db, order, preselected?.name ?? null, data, null);
}

async function renderForm(
  c: Context<AppEnv>,
  db: Session,
  order: OrderEditRow | null,
  preselectedFoodbankName: string | null,
  data: OrderFormData,
  error: string | null,
): Promise<Response> {
  const [openFoodbanks, needs, orderGroups] = await Promise.all([
    getOpenFoodbankOptions(db),
    getNeedOptionsForFoodbank(db, data.foodbank_id, NEED_OPTION_LIMIT),
    getOrderGroupOptions(db),
  ]);

  // See getFoodbankOptionById's own comment: Django's queryset excludes
  // closed food banks, so an order on a since-closed food bank would lose
  // its selection on the next save. Append the current one if it is
  // missing from the open list.
  let foodbanks: FoodbankOptionRow[] = openFoodbanks;
  if (data.foodbank_id !== null && !openFoodbanks.some((fb) => fb.id === data.foodbank_id)) {
    const current = await getFoodbankOptionById(db, data.foodbank_id);
    if (current) foodbanks = [...openFoodbanks, current];
  }

  // views.py:479-485. Foodbank.__str__ is `self.name`
  // (givefood/models/foodbank.py:142-143).
  const pageTitle = order ? `Edit ${order.order_id}` : preselectedFoodbankName ? `New Order for ${preselectedFoodbankName}` : "New Order";

  const html = await render("admin/order_form.njk", {
    ...(await adminPageContext(c, "orders")),
    page_title: pageTitle,
    // Django's generic admin/form.html has no Back link; this port's
    // generic_form.njk does, so follow the port's own convention.
    back_url: order ? `/admin/order/${encodeURIComponent(order.order_id)}/` : "/admin/orders/",
    error,
    data,
    foodbanks,
    needs: needs.map((need) => ({ id: need.id, label: needOptionLabel(need) })),
    needs_capped: needs.length >= NEED_OPTION_LIMIT,
    order_groups: orderGroups,
    delivery_hours: DELIVERY_HOURS,
    delivery_providers: DELIVERY_PROVIDERS,
  });
  return c.html(html);
}

async function handlePost(c: Context<AppEnv>, db: Session, order: OrderEditRow | null): Promise<Response> {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  // Django's ModelForm supplies all of this validation for free
  // (forms.py:192-194's `fields = "__all__"` over the Order model's own
  // field definitions); there is no ModelForm here, so every field is
  // checked explicitly. A failure re-renders the form with the submitted
  // values preserved and one message at the top -- which is what a bound
  // Django form does, since views.py:468-471 falls through to the same
  // render() when is_valid() is false.
  const itemsText = typeof body.items_text === "string" ? body.items_text : "";
  const deliveryDate = formValue(body, "delivery_date");
  const deliveryHourRaw = formValue(body, "delivery_hour");
  const deliveryProviderRaw = formValue(body, "delivery_provider");
  const deliveryProviderId = formValue(body, "delivery_provider_id");
  const sourceUrlRaw = formValue(body, "source_url");
  const actualCostRaw = formValue(body, "actual_cost");

  // `undefined` means "present but not a usable id" -- distinct from the
  // legitimate empty selection, which is null.
  const parseFk = (key: string): number | null | undefined => {
    const raw = formValue(body, key);
    if (raw === "") return null;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  };
  const foodbankIdRaw = parseFk("foodbank");
  const needIdRaw = parseFk("need");
  const orderGroupIdRaw = parseFk("order_group");

  const data: OrderFormData = {
    foodbank_id: foodbankIdRaw ?? null,
    items_text: itemsText,
    need_id: needIdRaw ?? null,
    order_group_id: orderGroupIdRaw ?? null,
    source_url: sourceUrlRaw === "" ? null : sourceUrlRaw,
    delivery_date: deliveryDate,
    delivery_hour: deliveryHourRaw === "" ? null : Number(deliveryHourRaw),
    delivery_provider: deliveryProviderRaw === "" ? null : deliveryProviderRaw,
    delivery_provider_id: deliveryProviderId === "" ? null : deliveryProviderId,
    actual_cost: actualCostRaw === "" ? null : Number(actualCostRaw),
  };

  const fail = (message: string) => renderForm(c, db, order, null, data, message);

  if (itemsText.trim() === "") return fail("Items text is required."); // orders.py:31, no blank=True
  if (!isValidDate(deliveryDate)) return fail("Delivery date is required and must be a real date.");
  if (!DELIVERY_HOURS.includes(Number(deliveryHourRaw))) return fail("Delivery hour must be one of the listed hours.");
  if (deliveryProviderRaw !== "" && !DELIVERY_PROVIDERS.includes(deliveryProviderRaw)) return fail("Unknown delivery provider.");
  if (sourceUrlRaw !== "" && !isValidUrl(sourceUrlRaw)) return fail("Source URL must be a valid http(s) URL.");
  // PositiveIntegerField (orders.py:49) -- pence, so whole numbers only.
  if (actualCostRaw !== "" && !/^\d+$/.test(actualCostRaw)) return fail("Delivered cost must be a whole number of pence.");
  if (foodbankIdRaw === undefined || needIdRaw === undefined || orderGroupIdRaw === undefined) return fail("Invalid selection.");

  const foodbankId = foodbankIdRaw;
  const needId = needIdRaw;
  const orderGroupId = orderGroupIdRaw;

  // A client-supplied FK is never trusted to exist -- Django's
  // ModelChoiceField resolves each one against its queryset, which is both
  // the existence check and (for `foodbank`) the is_closed filter.
  let foodbank: FoodbankOptionRow | null = null;
  if (foodbankId !== null) {
    foodbank = await getFoodbankOptionById(db, foodbankId);
    if (!foodbank) return fail("Unknown food bank.");
    // Django rejects a closed food bank outright (it is not in
    // forms.py:190's queryset). Allowed here ONLY when it is the one this
    // order already had -- see getFoodbankOptionById's comment. Choosing a
    // different closed one is still rejected.
    if (foodbank.is_closed && order?.foodbank_id !== foodbank.id) return fail("That food bank is closed.");
  }
  if (needId !== null && !(await db.prepare("SELECT id FROM foodbankchange WHERE id = ?").bind(needId).first())) return fail("Unknown need.");
  if (orderGroupId !== null && !(await db.prepare("SELECT id FROM ordergroup WHERE id = ?").bind(orderGroupId).first())) return fail("Unknown order group.");

  // Order.Meta.unique_together (orders.py:57).
  const conflict = await findConflictingOrder(db, { foodbankId, deliveryDate, deliveryProvider: data.delivery_provider, excludeId: order?.id });
  if (conflict) return fail("Order with this Foodbank, Delivery date and Delivery provider already exists.");

  // --- everything models/orders.py:97-128 derives (all editable=False) ---
  const deliveryHour = Number(deliveryHourRaw);
  const isNew = order === null;
  const country = foodbank ? foodbank.country : ""; // orders.py:125-128 -- "" for unassigned; the column is NOT NULL, so not NULL

  let finalOrderId: string;
  if (foodbank) {
    // orders.py:105-107. NOTE: this REGENERATES the order_id on every save
    // of an assigned order, so changing the food bank, provider or
    // delivery date CHANGES THE ORDER'S ADMIN URL and the old one 404s
    // afterwards. Django behaves exactly this way (views.py:472 redirects
    // to the new id); ported faithfully rather than "fixed", because the
    // id is a human-readable key that also appears in the notification
    // email's subject and body.
    finalOrderId = `gf-${foodbank.slug}-${slugifyProvider(data.delivery_provider)}-${deliveryDate}`;
  } else if (isNew) {
    // orders.py:102-104's `temp-order-<uuid4>` placeholder, replaced below
    // once the insert has produced a primary key.
    finalOrderId = `temp-order-${crypto.randomUUID()}`;
  } else {
    // Neither orders.py:102 nor :105 fires when editing an UNASSIGNED
    // order (is_new False, foodbank None) -- its order_id stays frozen.
    finalOrderId = order.order_id;
  }

  const previousFoodbankId = order?.foodbank_id ?? null;

  // orders.py:107 destroys every existing line here, BEFORE the parse that
  // regenerates them -- so in Django a Gemini failure loses the lot with no
  // way back. Not ported: the delete lives in the queue consumer instead
  // (workers/jobs/src/adminJobs/orderLines.ts), immediately before the
  // insert, so a failed or unconfigured parse leaves the previous lines
  // intact. The cost is that the order page can show the old lines for the
  // few seconds the job is in flight; the job banner says so, and stale
  // lines beat destroyed ones.

  const saved = await upsertOrder(
    db,
    {
      orderId: finalOrderId,
      foodbankId,
      itemsText,
      needId,
      orderGroupId,
      country,
      sourceUrl: data.source_url,
      deliveryDate,
      deliveryHour,
      deliveryDatetime: deliveryDatetime(deliveryDate, deliveryHour),
      deliveryProvider: data.delivery_provider,
      deliveryProviderId: data.delivery_provider_id,
      actualCost: actualCostRaw === "" ? null : Number(actualCostRaw),
    },
    order?.id,
  );

  // orders.py:207-211 -- a new unassigned order's real id needs the pk.
  if (isNew && foodbankId === null) {
    finalOrderId = `gf-unassigned-${saved.id}-${slugifyProvider(data.delivery_provider)}-${deliveryDate}`;
    await setOrderId(db, saved.id, finalOrderId);
  }

  // orders.py:214-216. The second call is NOT in Django: an edit that
  // moves an order to a different food bank leaves the PREVIOUS one
  // advertising a last_order it no longer has.
  if (foodbankId !== null) await recomputeFoodbankLastOrder(db, foodbankId);
  if (previousFoodbankId !== null && previousFoodbankId !== foodbankId) await recomputeFoodbankLastOrder(db, previousFoodbankId);

  // The AI line parse, as an admin_job the order page polls -- the whole
  // reason this handler can return in milliseconds. Same enqueue shape as
  // adminFoodbankCheck (foodbankCheck.ts:53-56).
  const jobId = crypto.randomUUID();
  await insertAdminJob(db, { id: jobId, kind: "order-lines", target: finalOrderId });
  await c.env.JOBS_Q.send({ type: "order-lines", jobId, orderRowId: saved.id });

  // views.py:472 redirects to admin:order with the (possibly regenerated)
  // order_id; `?job=` is this port's addition, so the page can show the
  // parse's progress instead of an order that looks empty.
  return c.redirect(`/admin/order/${encodeURIComponent(finalOrderId)}/?job=${jobId}`, 302);
}
