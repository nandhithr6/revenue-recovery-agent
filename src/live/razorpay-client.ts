import type { RazorpayCredentials } from './env.js';

/**
 * A very small Razorpay API client.
 *
 * Only the endpoints this project actually uses, written against the documented
 * REST API with `fetch`. No SDK: the official package pulls a dependency tree we
 * would then have to vouch for, to save us about forty lines.
 *
 * Every call is test mode, enforced upstream by `requireTestCredentials`.
 */

const BASE = 'https://api.razorpay.com/v1';

export interface RazorpayError {
  readonly code: string;
  readonly description: string;
  readonly source?: string;
  readonly step?: string;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RazorpayOrder {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly receipt?: string;
  readonly status: string;
  readonly created_at: number;
}

export interface RazorpayPaymentLink {
  readonly id: string;
  readonly short_url: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly description?: string;
}

export interface RazorpayPayment {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly method?: string;
  readonly error_code?: string | null;
  readonly error_description?: string | null;
  readonly error_source?: string | null;
  readonly error_step?: string | null;
  readonly error_reason?: string | null;
}

export class RazorpayApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

export class RazorpayClient {
  private readonly auth: string;

  constructor(creds: RazorpayCredentials) {
    // Basic auth, per the documented scheme. The secret never leaves this object.
    this.auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${this.auth}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new RazorpayApiError(res.status, text, `Non-JSON response from ${path}`);
    }

    if (!res.ok) {
      const err = (parsed as { error?: RazorpayError }).error;
      throw new RazorpayApiError(
        res.status,
        parsed,
        `${method} ${path} failed (${res.status}): ${err?.description ?? 'unknown error'}`,
      );
    }

    return parsed as T;
  }

  /** Confirm the credentials work, without creating anything. */
  async ping(): Promise<boolean> {
    // Listing orders is read-only and cheap; a 401 here means bad credentials.
    await this.request<{ items: unknown[] }>('GET', '/orders?count=1');
    return true;
  }

  /**
   * Create an order — the object a payment is made against.
   *
   * @param amountPaise Razorpay takes the smallest currency unit, which is why
   *   this project keeps money in integer paise everywhere. No conversion here.
   */
  async createOrder(
    amountPaise: number,
    receipt: string,
    notes?: Record<string, string>,
  ): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>('POST', '/orders', {
      amount: amountPaise,
      currency: 'INR',
      receipt,
      ...(notes ? { notes } : {}),
    });
  }

  /**
   * Create a payment link — a real, openable URL the customer can pay through.
   *
   * This is what makes the agent's `contact_customer` action concrete rather
   * than simulated: the recovery message carries a genuine Razorpay link.
   */
  async createPaymentLink(input: {
    amountPaise: number;
    description: string;
    customerName?: string;
    customerEmail?: string;
    notes?: Record<string, string>;
  }): Promise<RazorpayPaymentLink> {
    return this.request<RazorpayPaymentLink>('POST', '/payment_links', {
      amount: input.amountPaise,
      currency: 'INR',
      description: input.description,
      // Notifications off: this is a test account and there is no real customer
      // to email. The link itself is the artefact we want.
      notify: { sms: false, email: false },
      reminder_enable: false,
      ...(input.customerName || input.customerEmail
        ? {
            customer: {
              ...(input.customerName ? { name: input.customerName } : {}),
              ...(input.customerEmail ? { email: input.customerEmail } : {}),
            },
          }
        : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
  }

  /** Payments made against an order, including failed ones with their real error fields. */
  async paymentsForOrder(orderId: string): Promise<RazorpayPayment[]> {
    const res = await this.request<{ items: RazorpayPayment[] }>(
      'GET',
      `/orders/${orderId}/payments`,
    );
    return res.items;
  }

  async fetchPaymentLink(id: string): Promise<RazorpayPaymentLink> {
    return this.request<RazorpayPaymentLink>('GET', `/payment_links/${id}`);
  }
}
