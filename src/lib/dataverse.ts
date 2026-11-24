import { PaymentEnvironmentConfig } from "../config/payments-environment";

export type FetchLike = typeof fetch;

// Option-set value for "Active" on suj_access_status.
export const ACCESS_ACTIVE = 100000000;

// Single-valued navigation property names used when binding lookups. These follow the
// lookup schema names (case-sensitive in the Dataverse Web API). Verify against the
// environment's metadata if a create returns "undeclared property".
const NAV = { learner: "suj_Learner", course: "suj_Online_Course" } as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: unknown): value is string {
  return typeof value === "string" && GUID.test(value.replace(/[{}]/g, ""));
}

export function cleanGuid(value: string): string {
  return value.replace(/[{}]/g, "").toLowerCase();
}

export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface Course {
  id: string;
  name: string;
  price: number;
  currency: string;
  active: boolean;
}

export interface Coupon {
  id: string;
  code: string;
  discountAmount: number;
  maximumUses: number | null;
  timesUsed: number;
  etag: string;
}

export interface Enrollment {
  id: string;
  accessStatus: number;
  orderId: string | null;
}

export class DataverseClient {
  private token?: { value: string; expires: number };

  constructor(
    private readonly config: PaymentEnvironmentConfig["dataverse"],
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private get base(): string {
    return `${this.config.url!.replace(/\/$/, "")}/api/data/v9.2`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const response = await this.fetcher(
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId!,
          client_secret: this.config.clientSecret!,
          scope: `${this.config.url!.replace(/\/$/, "")}/.default`,
        }),
      },
    );
    if (!response.ok) throw new Error(`Dataverse sign-in failed (${response.status}).`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.base}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    return response;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.call(path);
    if (!response.ok) throw new Error(`Dataverse read failed (${response.status}) for ${path.split("?")[0]}.`);
    return (await response.json()) as T;
  }

  async getCourse(courseId: string): Promise<Course | undefined> {
    const response = await this.call(
      `suj_onlinecourses(${cleanGuid(courseId)})?$select=suj_name,suj_price,statecode&$expand=transactioncurrencyid($select=isocurrencycode)`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Dataverse read failed (${response.status}) for suj_onlinecourses.`);
    const row = (await response.json()) as Record<string, any>;
    return {
      id: cleanGuid(courseId),
      name: row.suj_name ?? "Online course",
      price: Number(row.suj_price ?? 0),
      currency: row.transactioncurrencyid?.isocurrencycode ?? "USD",
      active: row.statecode === 0,
    };
  }

  async findCoupon(code: string): Promise<Coupon | undefined> {
    const filter = `suj_couponcode eq ${odataString(code)} and statecode eq 0`;
    const data = await this.getJson<{ value: Array<Record<string, any>> }>(
      `suj_paymentcoupons?$select=suj_paymentcouponid,suj_couponcode,tsj_discountamount,suj_maximumuses,suj_timesused&$filter=${encodeURIComponent(filter)}&$top=1`,
    );
    const row = data.value[0];
    if (!row) return undefined;
    return {
      id: cleanGuid(row.suj_paymentcouponid),
      code: row.suj_couponcode,
      discountAmount: Number(row.tsj_discountamount ?? 0),
      maximumUses: row.suj_maximumuses ?? null,
      timesUsed: Number(row.suj_timesused ?? 0),
      etag: row["@odata.etag"] ?? "*",
    };
  }

  couponHasUsesLeft(coupon: Coupon): boolean {
    return coupon.maximumUses === null || coupon.timesUsed < coupon.maximumUses;
  }

  /** Adds one use to a coupon, retrying if another redemption lands first. */
  async redeemCoupon(couponId: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.getJson<Record<string, any>>(
        `suj_paymentcoupons(${cleanGuid(couponId)})?$select=suj_timesused`,
      );
      const response = await this.call(`suj_paymentcoupons(${cleanGuid(couponId)})`, {
        method: "PATCH",
        headers: { "If-Match": row["@odata.etag"] ?? "*" },
        body: JSON.stringify({ suj_timesused: Number(row.suj_timesused ?? 0) + 1 }),
      });
      if (response.ok) return;
      if (response.status !== 412) throw new Error(`Coupon redemption failed (${response.status}).`);
    }
    throw new Error("Coupon redemption kept conflicting; giving up.");
  }

  private toEnrollment(row: Record<string, any>): Enrollment {
    return {
      id: cleanGuid(row.suj_onlinecourseenrollmentid),
      accessStatus: Number(row.suj_access_status ?? 0),
      orderId: row.suj_paypal_order_id ?? null,
    };
  }

  async findEnrollmentByOrder(orderId: string): Promise<Enrollment | undefined> {
    const data = await this.getJson<{ value: Array<Record<string, any>> }>(
      `suj_onlinecourseenrollments?$select=suj_onlinecourseenrollmentid,suj_access_status,suj_paypal_order_id&$filter=${encodeURIComponent(`suj_paypal_order_id eq ${odataString(orderId)}`)}&$top=1`,
    );
    return data.value[0] ? this.toEnrollment(data.value[0]) : undefined;
  }

  async findEnrollment(courseId: string, contactId: string): Promise<Enrollment | undefined> {
    const filter = `_suj_online_course_value eq ${cleanGuid(courseId)} and _suj_learner_value eq ${cleanGuid(contactId)}`;
    const data = await this.getJson<{ value: Array<Record<string, any>> }>(
      `suj_onlinecourseenrollments?$select=suj_onlinecourseenrollmentid,suj_access_status,suj_paypal_order_id&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=1`,
    );
    return data.value[0] ? this.toEnrollment(data.value[0]) : undefined;
  }

  /**
   * Gives a learner active access. An existing enrollment is reactivated instead of
   * duplicated. Returns whether anything changed so callers redeem coupons only once.
   */
  async grantEnrollment(input: {
    courseId: string;
    courseName: string;
    contactId: string;
    orderId?: string;
    captureId?: string;
  }): Promise<{ enrollmentId: string; created: boolean; changed: boolean }> {
    if (input.orderId) {
      const done = await this.findEnrollmentByOrder(input.orderId);
      if (done) return { enrollmentId: done.id, created: false, changed: false };
    }
    const payment = {
      ...(input.orderId ? { suj_paypal_order_id: input.orderId } : {}),
      ...(input.captureId ? { suj_paypal_capture_id: input.captureId } : {}),
    };
    const existing = await this.findEnrollment(input.courseId, input.contactId);
    if (existing) {
      if (existing.accessStatus === ACCESS_ACTIVE && !input.orderId) {
        return { enrollmentId: existing.id, created: false, changed: false };
      }
      const response = await this.call(`suj_onlinecourseenrollments(${existing.id})`, {
        method: "PATCH",
        body: JSON.stringify({ suj_access_status: ACCESS_ACTIVE, ...payment }),
      });
      if (!response.ok) throw new Error(`Enrollment update failed (${response.status}).`);
      return { enrollmentId: existing.id, created: false, changed: true };
    }
    const response = await this.call("suj_onlinecourseenrollments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        suj_name: input.courseName.slice(0, 100),
        suj_access_status: ACCESS_ACTIVE,
        [`${NAV.learner}@odata.bind`]: `/contacts(${cleanGuid(input.contactId)})`,
        [`${NAV.course}@odata.bind`]: `/suj_onlinecourses(${cleanGuid(input.courseId)})`,
        ...payment,
      }),
    });
    if (!response.ok) throw new Error(`Enrollment create failed (${response.status}).`);
    const row = (await response.json()) as Record<string, any>;
    return { enrollmentId: cleanGuid(row.suj_onlinecourseenrollmentid), created: true, changed: true };
  }
}
