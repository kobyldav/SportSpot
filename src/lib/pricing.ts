/**
 * Dynamic pricing — výpočet ceny pro zákazníka.
 * Vytvořeno David Kobylka všechny prava vyhrazeny pro službu SportSpot
 * Princip:
 *   - Provozovatel nastaví svou cenu (co chce dostat na účet)
 *   - Platforma přidá provizi 1-10 % podle obsazenosti
 *   - Poplatek platební brány vždy zahrnut
 *   - OCHRANA: platforma nikdy nejde do mínusu, vždy min 1% čistý výnos
 */

// ─── KONFIGURACE POPLATKŮ ───────────────────────────

// GoPay QR — téměř nulový fixní poplatek
// GoPay karta / Stripe — vyšší poplatek
const GATEWAY = {
  qr:        { pct: 0.009, fixed: 0 },      // QR platba — nejlevnější
  card:      { pct: 0.015, fixed: 650 },    // karta — 1,5 % + 6,50 Kč (v haléřích)
  apple_pay: { pct: 0.015, fixed: 650 },
  google_pay:{ pct: 0.015, fixed: 650 },
  tap_to_pay:{ pct: 0.015, fixed: 650 },    // Stripe Terminal walk-in
};

const MIN_PLATFORM_MARGIN = 0.01; // platforma vždy vydělá min 1 % z ceny

type PaymentMethod = keyof typeof GATEWAY;

interface PricingInput {
  providerRate: number;       // co chce provozovatel (haléře)
  occupancyRatio: number;     // 0.0 - 1.0 obsazenost dne
  minutesUntilSlot: number;   // za kolik minut slot začíná
  dayOfWeek: number;          // 0=Ne, 6=So
  hour: number;               // 0-23
  paymentMethod: PaymentMethod;
}

interface PricingResult {
  customerPrice: number;      // co zákazník zaplatí (haléře)
  providerAmount: number;     // co dostane provozovatel
  platformFee: number;        // čistý výnos platformy
  gatewayFee: number;         // poplatek brány
  platformPct: number;        // skutečné % provize (pro audit)
  discountReason: string | null;
}

/**
 * Hlavní výpočet ceny. Čistá funkce — 0 DB operací.
 */
export function calculatePrice(input: PricingInput): PricingResult {
  const { providerRate, occupancyRatio, minutesUntilSlot, dayOfWeek, hour, paymentMethod } = input;

  // 1. Základní provize podle obsazenosti
  let platformPct: number;
  if (occupancyRatio > 0.9)       platformPct = 0.10;
  else if (occupancyRatio > 0.7)  platformPct = 0.07;
  else if (occupancyRatio > 0.4)  platformPct = 0.05;
  else                            platformPct = 0.02;

  let discountReason: string | null = null;

  // 2. Last-minute sleva
  if (minutesUntilSlot < 60 && occupancyRatio < 0.5) {
    platformPct = Math.max(0.01, platformPct - 0.01);
    discountReason = "last_minute";
  }

  // 3. Víkendová špička (hardcoded prozatím)
  const isPeak = (dayOfWeek === 5 && hour >= 17) ||
                 (dayOfWeek === 6 && hour >= 9 && hour <= 12);
  if (isPeak) {
    platformPct = Math.min(0.10, platformPct + 0.02);
  }

  // 4. Výpočet čistého výnosu platformy v haléřích
  // Vypočteme si, kolik chceme čistého před poplatky brány
  const desiredPlatformNet = Math.round(providerRate * platformPct);
  
  // OCHRANA: Platforma má vždy minimálně stanovené % z ceny provozovatele
  const minNet = Math.ceil(providerRate * MIN_PLATFORM_MARGIN);
  const actualPlatformNet = Math.max(desiredPlatformNet, minNet);

  // 5. Zahrnutí poplatku platební brány (The Math Fix)
  const gw = GATEWAY[paymentMethod];
  
  // Rovnice: CustomerPrice = (ProviderRate + NetPlatformFee + GW_Fixed) / (1 - GW_Percent)
  const numerator = providerRate + actualPlatformNet + gw.fixed;
  const denominator = 1 - gw.pct;
  
  // Používáme Math.ceil, abychom při zaokrouhlení nepřišli o haléře v náš neprospěch
  const customerPrice = Math.ceil(numerator / denominator);

  // 6. Zpětný výpočet reálných částek pro účetnictví
  // Brána vždy zaokrouhluje svůj poplatek standardně (Math.round)
  const gatewayFee = Math.round(customerPrice * gw.pct) + gw.fixed;
  
  // Co skutečně zbyde platformě
  const netPlatformFee = customerPrice - providerRate - gatewayFee;

  return {
    customerPrice,
    providerAmount: providerRate,
    platformFee: netPlatformFee, // Nyní toto číslo vždy svítí v plusu!
    gatewayFee,
    platformPct: netPlatformFee / providerRate, // Reálné % navýšení nad cenu provozovatele
    discountReason,
  };
}

/**
 * Pomocná funkce — formátování haléřů na Kč pro zobrazení.
 */
export function halereToKc(halere: number): string {
  return (halere / 100).toLocaleString("cs-CZ", {
    style: "currency", currency: "CZK", maximumFractionDigits: 0,
  });
}

/**
 * Výpočet obsazenosti kurtu pro daný den.
 * Vrací poměr 0.0 - 1.0 (obsazené sloty / celkové sloty).
 */
export function calcOccupancy(bookedSlots: number, totalSlots: number): number {
  if (totalSlots === 0) return 0;
  return Math.min(1, bookedSlots / totalSlots);
}
