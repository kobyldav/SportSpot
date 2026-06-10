/**
 * CourtBooking — Durable Object pro zamykání slotů.
 *
 * KLÍČOVÁ ČÁST CELÉHO SYSTÉMU.
 *
 * Problém který řeší:
 *   Dva zákazníci kliknou na stejný slot ve stejnou milisekundu.
 *   Bez ochrany oba dostanou potvrzení → double booking → katastrofa.
 *
 * Jak to funguje:
 *   Každý kurt má svůj VLASTNÍ Durable Object (idFromName(courtId)).
 *   Durable Object je single-threaded — zpracovává požadavky JEDEN PO DRUHÉM.
 *   Takže i kdyby přišlo 1000 požadavků naráz, vyřídí se sériově.
 *
 * Tok:
 *   1. reserve()  → zamkne slot na 5 min (čas na platbu)
 *   2. confirm()  → platba prošla, slot trvale obsazen
 *   3. release()  → platba selhala/timeout, slot uvolněn
 *
 * SQLite-backed Durable Object — funguje na Workers Free plánu.
 */

interface SlotState {
  userId: string;
  status: "locked" | "confirmed";
  lockedAt: number;
  expiresAt: number;
}

const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minut na dokončení platby

export class CourtBooking {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();

    try {
      switch (action) {
        case "reserve": return await this.handleReserve(request);
        case "confirm": return await this.handleConfirm(request);
        case "release": return await this.handleRelease(request);
        case "status":  return await this.handleStatus(request);
        default:        return Response.json({ error: "unknown action" }, { status: 400 });
      }
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  /**
   * Pokus o zamknutí slotu. Atomický — díky single-threaded povaze DO.
   */
  private async handleReserve(request: Request): Promise<Response> {
    const { date, startTime, userId } = await request.json() as
      { date: string; startTime: string; userId: string };

    const slotKey = `${date}:${startTime}`;
    const existing = await this.ctx.storage.get<SlotState>(slotKey);

    // Slot už je obsazen?
if (existing) {
  if (existing.status === "locked" && existing.expiresAt < Date.now()) {
    await this.ctx.storage.delete(slotKey);
  } else if (existing.status === "locked" && existing.userId === userId) {
    return Response.json({
      success: true,
      lockExpiresAt: existing.expiresAt, // nebo posunout: now + LOCK_DURATION_MS
    });
  } else {
    return Response.json({
      success: false,
      reason: existing.status === "confirmed" ? "obsazeno" : "rezervuje_nekdo_jiny",
    });
  }
}

    // Zamknout slot
    const now = Date.now();
    const state: SlotState = {
      userId,
      status: "locked",
      lockedAt: now,
      expiresAt: now + LOCK_DURATION_MS,
    };
    await this.ctx.storage.put(slotKey, state);

    // Naplánovat automatické uvolnění pokud platba nedorazí
    await this.ctx.storage.setAlarm(now + LOCK_DURATION_MS);

    return Response.json({
      success: true,
      lockExpiresAt: state.expiresAt,
    });
  }

  /**
   * Potvrzení slotu po úspěšné platbě → trvalý zámek.
   * Voláno z webhook handleru po Stripe/GoPay potvrzení.
   */
  private async handleConfirm(request: Request): Promise<Response> {
    const { date, startTime, userId } = await request.json() as
      { date: string; startTime: string; userId: string };

    const slotKey = `${date}:${startTime}`;
    const existing = await this.ctx.storage.get<SlotState>(slotKey);

    if (!existing) {
      return Response.json({ success: false, reason: "slot_neni_zamcen" });
    }
    if (existing.userId !== userId) {
      return Response.json({ success: false, reason: "jiny_uzivatel" });
    }

    await this.ctx.storage.put(slotKey, {
      ...existing,
      status: "confirmed",
    });

    return Response.json({ success: true });
  }

  /**
   * Uvolnění slotu — při zrušení rezervace nebo selhání platby.
   */
  private async handleRelease(request: Request): Promise<Response> {
    const { date, startTime } = await request.json() as
      { date: string; startTime: string };

    await this.ctx.storage.delete(`${date}:${startTime}`);
    return Response.json({ success: true });
  }

  /**
   * Zjištění stavu slotu (bez modifikace).
   */
  private async handleStatus(request: Request): Promise<Response> {
    const { date, startTime } = await request.json() as
      { date: string; startTime: string };

    const state = await this.ctx.storage.get<SlotState>(`${date}:${startTime}`);
    if (!state) return Response.json({ status: "free" });

    // Vypršelý zámek = volný
    if (state.status === "locked" && state.expiresAt < Date.now()) {
      return Response.json({ status: "free" });
    }
    return Response.json({ status: state.status });
  }

  /**
   * Alarm — automatické uvolnění vypršelých zámků.
   * Cloudflare zavolá tuto metodu v naplánovaný čas.
   */
  async alarm(): Promise<void> {
    const all = await this.ctx.storage.list<SlotState>();
    const now = Date.now();
    let nextAlarm = 0;

    for (const [slotKey, state] of all) {
      // Uvolnit vypršelé zámky (nepotvrzené)
      if (state.status === "locked" && state.expiresAt < now) {
        await this.ctx.storage.delete(slotKey);
      } else if (state.status === "locked") {
        // Najdi nejbližší další expiraci pro příští alarm
        if (nextAlarm === 0 || state.expiresAt < nextAlarm) {
          nextAlarm = state.expiresAt;
        }
      }
    }

    // Naplánuj další alarm pokud jsou ještě aktivní zámky
    if (nextAlarm > 0) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }
}

// ─── HELPER pro volání z Workeru ────────────────────

/**
 * Pomocná funkce pro volání CourtBooking DO z hlavního Workeru.
 * Zjednodušuje práci — nemusíš ručně sestavovat fetch.
 */
export class CourtLock {
  constructor(private ns: DurableObjectNamespace, private courtId: string) {}

  private stub() {
    return this.ns.get(this.ns.idFromName(this.courtId));
  }

  async reserve(date: string, startTime: string, userId: string) {
    const res = await this.stub().fetch("https://do/reserve", {
      method: "POST",
      body: JSON.stringify({ date, startTime, userId }),
    });
    return res.json() as Promise<{ success: boolean; reason?: string; lockExpiresAt?: number }>;
  }

  async confirm(date: string, startTime: string, userId: string) {
    const res = await this.stub().fetch("https://do/confirm", {
      method: "POST",
      body: JSON.stringify({ date, startTime, userId }),
    });
    return res.json() as Promise<{ success: boolean; reason?: string }>;
  }

  async release(date: string, startTime: string) {
    const res = await this.stub().fetch("https://do/release", {
      method: "POST",
      body: JSON.stringify({ date, startTime }),
    });
    return res.json() as Promise<{ success: boolean }>;
  }

  async status(date: string, startTime: string) {
    const res = await this.stub().fetch("https://do/status", {
      method: "POST",
      body: JSON.stringify({ date, startTime }),
    });
    return res.json() as Promise<{ status: "free" | "locked" | "confirmed" }>;
  }
}
