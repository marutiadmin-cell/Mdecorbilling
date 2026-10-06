import type { GstType } from "@/lib/gstin";
import type { EstimateKind, EstimateStatus } from "@/lib/estimates";

export type ID = string;

export interface Party {
  id: ID;
  name: string;
  type: "customer" | "supplier" | "both";
  phone?: string;
  email?: string;
  /** A second number, for the works or the accounts desk. */
  phone2?: string;
  /** Who to ask for when you ring. */
  contactPerson?: string;
  /** A short name the shop actually uses, when the legal name is a mouthful. */
  alias?: string;
  /** Free grouping — "Mumbai dealers", "Site contractors". */
  group?: string;

  gstin?: string;
  /**
   * How this customer is registered. It changes what a bill may claim, and a
   * composition dealer or an unregistered buyer is not the same invoice as a
   * registered one. See lib/gstin.ts.
   */
  gstType?: GstType;
  /** Registered with effect from — what their certificate says. */
  gstinWef?: string;
  pan?: string;
  /** For a proprietor. Their software carries it, so this one does too. */
  birthDate?: string;

  address?: string;
  addressLine2?: string;
  area?: string;
  city?: string;
  /** The state's NAME, for printing. */
  state?: string;
  /**
   * The GST state code — two digits, and the thing that actually decides
   * whether a bill carries CGST+SGST or IGST. Kept alongside the name rather
   * than derived from it, because a name can be spelled six ways and a code
   * cannot. Auto-filled from the GSTIN's first two characters.
   */
  stateCode?: string;
  zipCode?: string;
  country?: string;
  shippingAddress?: string;
  /** Every distinct "Ship To" address this party has had an invoice billed
   *  to, most-recent-first, capped at ~10 — what populates the suggestion
   *  list on a new sale so a repeat delivery address is one click away
   *  instead of retyped. `shippingAddress` above stays as the single
   *  "default" slot; this is the full history behind it. */
  shipToHistory?: string[];

  openingBalance: number;
  creditLimit?: number;
  /** How many days of credit, alongside how much. */
  creditDays?: number;
  /** Tax collected at source, as a percentage. */
  tcsPct?: number;

  /** Who introduced them, and what that costs. */
  broker?: string;
  brokeragePct?: number;
  salesPerson?: string;
  /** Their reference in the shop's other systems. */
  clientCode?: string;
  /**
   * Their reference in the shop's PREVIOUS system.
   *
   * Carried because the shop's own Customer Master has it and their people
   * quote it to each other. Nothing here reads it — it exists so a party can
   * be found by the number the office already says out loud.
   */
  companyId?: string;
  remarks?: string;

  /**
   * Kept on file but not sellable to — a credit hold, usually.
   *
   * Different from `archived`: an archived party is gone from the pickers
   * because the shop has finished with them; a blocked one is still a live
   * customer whose next order has to be authorised.
   */
  blockedForSale?: boolean;
  /** Whether this party is sent SMS/WhatsApp alerts. */
  smsAlerts?: boolean;
  /** Soft-delete flag. An archived party is hidden from new-transaction
   * pickers and the active parties list, but its document is kept so every
   * existing invoice/payment/return, ledger, statement, report and dashboard
   * total that references it stays intact. Absence of the field means active
   * — so every party that predates this feature is active automatically. */
  archived?: boolean;
  createdAt: string;
}

export interface Item {
  id: ID;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  hsn?: string;
  gstRate: number;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice?: number;
  stock: number;
  minStock?: number;
  openingStock: number;
  description?: string;
  createdAt: string;
}

export interface LineItem {
  id: ID;
  itemId: ID;
  name: string;
  qty: number;
  unit: string;
  price: number;
  discountPct: number;
  gstRate: number;
  amount: number;
  /** Snapshot of the item's purchase price when the line was created — used for stock-based COGS in P&L */
  costPrice?: number;
  /**
   * The HSN or SAC code this line was billed under.
   *
   * Rule 46 requires it on a tax invoice. Snapshotted like costPrice: an
   * item's code gets corrected, and a filed invoice must keep saying what it
   * said. Falls back to the item's current code where a line predates this.
   */
  hsn?: string;
  /** Price in the foreign currency, before conversion — only set on
   * international purchases. `price` (INR) is auto-derived from this via
   * the parent Invoice's exchangeRate/carryCostPerUnit, but stays a normal
   * editable field so a cashier can still override the computed value. */
  foreignPrice?: number;
}

export type PaymentMode = "cash" | "bank" | "credit" | "upi" | "cheque";

/**
 * One part of a payment that was not all taken the same way.
 *
 * The shop settles a bill ₹4,000 cash and ₹6,000 into HDFC; that is two rows.
 * A document with no rows means what it has always meant — its own
 * paymentMode and amount — so nothing existing had to be rewritten to add
 * this. See docs/SPLIT-PAYMENT-PLAN.md and lib/paymentSplit.ts, which is the
 * only thing that should read these fields directly.
 */
export interface PaymentSplit {
  mode: PaymentMode;
  amount: number;
  /** Which account it landed in. Required for any mode that names one. */
  bankId?: ID;
}

/** One named extra charge on a bill — Freight, Packing & Forwarding,
 *  Insurance, Loading/Unloading, Installation, or whatever else the
 *  business actually bills for. See Invoice.additionalCharges. */
export interface AdditionalCharge {
  label: string;
  amount: number;
}

export interface Invoice {
  id: ID;
  number: string;
  date: string;
  partyId: ID;
  /**
   * The buyer's GST identity AS BILLED, not as they are today.
   *
   * Snapshotted the moment the party is chosen, for the same reason costPrice
   * is: a party's state can be corrected next year, and a reprint of last
   * year's invoice must show the tax it actually carried rather than the tax
   * it would carry now. `placeOfSupply` is the two-digit state code, and it
   * is the field that decides CGST+SGST against IGST — see lib/gstin.ts.
   *
   * All optional: every invoice written before this existed has none of them,
   * and falls back to intra-state, which is exactly what it printed.
   */
  /**
   * Whether tax on this supply is payable by the recipient.
   *
   * Rule 46 requires a tax invoice to STATE this either way, so the printed
   * bill says "No" rather than staying silent — silence is not an answer a
   * return can be checked against.
   */
  reverseCharge?: boolean;
  partyGstin?: string;
  partyAddress?: string;
  partyState?: string;
  placeOfSupply?: string;
  /** Where the goods actually go, if different from the billing address
   *  above — snapshotted at billing time like every other party detail here.
   *  Printed as its own block only when it differs from partyAddress; absent
   *  (every invoice before this existed) means "same as billing address",
   *  exactly what it printed before. */
  shipToAddress?: string;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  discount: number;
  /** Flat shipping/freight charge added to the total (sale bills only).
   *  Kept as the single source every existing tax calculation already reads
   *  (allocateAcrossRateBuckets, gstBuckets, hsnSummary, recalc) — when
   *  additionalCharges below is used, this is simply their sum, computed at
   *  save time, so none of that code needed to change to support more than
   *  one named charge. */
  shippingCharge?: number;
  /**
   * The itemised breakdown behind shippingCharge — Freight, Packing &
   * Forwarding, Insurance, Loading/Unloading, Installation, or anything
   * else the business actually bills for, printed by name instead of one
   * generic "Shipping Charge" line (matching the GST e-Invoice schema's own
   * treatment of these as separate named charges). Every one of them is
   * still taxed together as a single composite-supply amount — the SAME
   * total, proportionally split across this bill's GST-rate buckets — GST
   * law does not tax "Freight" and "Packing" as separate line items with
   * their own independent rates. An invoice saved before this existed has
   * no entries here and just shows its one legacy shippingCharge number. */
  additionalCharges?: AdditionalCharge[];
  taxAmount: number;
  /**
   * Which formula computed `taxAmount` — absent (every invoice before this
   * existed) means `discount`/`shippingCharge` were applied AFTER tax
   * (discount untaxed-back-out, shipping never taxed at all); `2` means both
   * were folded into the taxable value FIRST, split proportionally across
   * this bill's own GST rates (see allocateAcrossRateBuckets in lib/gstin.ts)
   * — the legally correct treatment under GST Section 15(3)(a) for the
   * discount and the composite-supply rule for shipping.
   *
   * Stamped once at save time and never touched again: a filed invoice's tax
   * is a historical fact, not something that silently restates itself the
   * next time the formula improves. Every reader that replays tax from line
   * items (PrintableInvoice, gstBuckets, hsnSummary) checks this FIRST and
   * replays whichever formula actually produced the stored total — never one
   * formula for every invoice regardless of when it was billed.
   */
  taxCalcVersion?: 2;
  /** Rounding applied to reach a whole-rupee total (e.g. −0.37 or +0.45) */
  roundOff?: number;
  total: number;
  paid: number;
  paymentMode: PaymentMode;
  /** Which bank account `paid` was collected into/from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Snapshot of `paid` at the moment it was attributed to bankId, so an edit can
   * reverse exactly that amount even if `paid` later grows via Payment allocations. */
  bankPaidAmount?: number;
  /** Set only when the paid amount was NOT all taken one way. Absent on every
   *  document written before splits existed, and on every single-mode one
   *  since. Read it through lib/paymentSplit.ts, never directly. */
  paidSplits?: PaymentSplit[];
  /** Purchase bills only — each line's `foreignPrice` (in the supplier's
   * currency) gets converted to INR as `foreignPrice * exchangeRate +
   * carryCostPerUnit`, so the landed per-unit cost (currency conversion +
   * freight/customs, per piece) is baked into the same `price` field
   * everything else (GST, discount, stock costing) already works off. */
  isInternational?: boolean;
  /** 1 unit of the foreign currency, in INR. */
  exchangeRate?: number;
  /** Flat per-piece freight/customs/handling cost, in INR, added on top of
   * the converted price — distinct from `shippingCharge` (a whole-bill
   * flat charge) since this applies per unit, before qty is multiplied in. */
  carryCostPerUnit?: number;
  notes?: string;
  createdAt: string;
}

/**
 * Who an expense was actually paid to (an employee, landlord, vendor...) —
 * separate from Category (what kind of expense it is), so "how much have I
 * paid Vikas, ever" is answerable without re-deriving it from free text.
 * Deliberately lightweight (no phone/GSTIN/balance like Party) — this is
 * just a name, grown organically as expenses are entered, not a form the
 * user fills out up front.
 */
export interface Payee {
  id: ID;
  name: string;
  /** Pre-fills Category when this payee is picked on a new expense — cuts
   * down on miscategorized entries for a payee that's (almost) always the
   * same kind of spend, e.g. picking "Vikas" always suggesting "Salary". */
  defaultCategory?: string;
  createdAt: string;
}

export interface Expense {
  id: ID;
  date: string;
  category: string;
  amount: number;
  paymentMode: PaymentMode;
  /** Which bank account this was paid from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Set only when this was not all taken one way. See PaymentSplit. */
  splits?: PaymentSplit[];
  /** Who this was actually paid to — see Payee. Optional on the type so
   * older records saved before this existed still load; the expense form
   * requires it going forward. */
  payeeId?: ID;
  payeeName?: string;
  notes?: string;
  createdAt: string;
}

export interface BankAccount {
  id: ID;
  name: string;
  accountNumber?: string;
  ifsc?: string;
  openingBalance: number;
  balance: number;
  createdAt: string;
}

/** Physical stock correction (damage, counting difference, samples…) */
export interface StockAdjustment {
  id: ID;
  itemId: ID;
  itemName: string;
  date: string;
  type: "add" | "reduce";
  qty: number;
  reason?: string;
  createdAt: string;
}

/** Manual cash-in-hand correction (counter counting, owner drawings…) */
export interface CashAdjustment {
  id: ID;
  date: string;
  type: "add" | "reduce";
  amount: number;
  reason?: string;
  /** Set when this row is one leg of a transfer between accounts. Deleting
   * either leg has to take the other with it, or the money is left half
   * moved — out of one account and never into the other. */
  transferId?: ID;
  createdAt: string;
}

export interface BankTxn {
  id: ID;
  bankId: ID;
  date: string;
  type: "deposit" | "withdraw" | "transfer";
  amount: number;
  notes?: string;
  /** See CashAdjustment.transferId — the same pairing, from the bank side. */
  transferId?: ID;
  createdAt: string;
}

/** How much of a payment was applied to which invoice — needed to reverse
 * invoice.paid when the payment is deleted, and to avoid double counting
 * in ledgers/cash reports. */
export interface PaymentAllocation {
  invoiceId: ID;
  number: string;
  /** Cash/bank actually applied to this invoice. */
  amount: number;
  /**
   * Amount written off on this invoice at the moment of settlement — a
   * "settlement discount". Collecting 20,000 against a 20,500 bill and
   * waiving the last 500 closes the bill without inventing 500 of cash:
   * the invoice's `paid` moves by amount + discount, while only `amount`
   * ever reaches the cash or bank position. The waived part is real cost to
   * the business, so the P&L subtracts it (see valueExTax/discountAllowed).
   */
  discount?: number;
}

export interface Payment {
  id: ID;
  date: string;
  partyId: ID;
  partyName: string;
  type: "in" | "out";
  amount: number;
  mode: PaymentMode;
  /** Which bank account this moved money into/out of — only set when mode is "bank". */
  bankId?: ID;
  /** Set only when this was not all taken one way. See PaymentSplit. */
  splits?: PaymentSplit[];
  ref?: string;
  allocations?: PaymentAllocation[];
  /**
   * The proforma this advance was taken against.
   *
   * A LABEL, not an allocation. The money is a receipt on the customer's
   * account exactly as it always was — it moves the party balance and the
   * bank the same way, and a proforma is not a receivable so nothing can be
   * settled against it. This only records which document prompted the
   * payment, so the proforma can show what has come in against it.
   */
  againstEstimateId?: ID;
  againstEstimateNumber?: string;
  createdAt: string;
}

/** Why a credit/debit note was raised — not itself a GST-mandated printed
 *  field, but the categorisation an accountant expects on every note for
 *  their own records. Optional: every note written before this existed
 *  prints and behaves exactly as it always did. */
export type ReturnReason = "sales-return" | "deficiency-in-service" | "price-revision" | "other";

export interface Return {
  id: ID;
  number: string;
  date: string;
  originalRef?: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  reason?: ReturnReason;
  /** Free text — required detail when reason is "other", optional extra
   *  context otherwise. */
  reasonNote?: string;
  /** A pure price/tax correction with no physical goods movement (e.g. a
   *  post-invoice rate correction) — see ReturnForm's relaxed line
   *  validation and finalizeSave's skipped stock reversal for this case. */
  isAdjustmentOnly?: boolean;
  /**
   * Which way an adjustment-only note moves value — absent/"decrease" means
   * exactly what every note before this field existed already meant (a
   * Credit Note reduces a sale, a Debit Note reduces a purchase). "increase"
   * is the other half of GST Section 34: a Debit Note that INCREASES a sale
   * (e.g. the customer was under-billed, or freight gets billed after the
   * original invoice) or a Credit Note that increases a purchase. Only
   * meaningful when `isAdjustmentOnly` is true — a PHYSICAL return is always
   * a decrease, there is no such thing as a goods return that adds value.
   */
  direction?: "decrease" | "increase";
  lineItems: LineItem[];
  subtotal: number;
  taxAmount: number;
  total: number;
  notes?: string;
  createdAt: string;
}

/**
 * A free-form accounting entry against the four "accounts" this app actually
 * has — a Party's balance, a Bank account, Cash-in-hand, or an Expense
 * category — for the things no other screen here has a form for: writing off
 * a bad debt, correcting an opening balance after the fact, moving a balance
 * between two parties, booking a non-cash adjustment. Tally calls this a
 * "Journal Voucher"; Zoho Books calls it a "Manual Journal" — same idea.
 *
 * Deliberately NOT a tax document: no GST is computed on a journal entry.
 *
 * "ledger" is a free-text fifth kind — a named account with no backing
 * document anywhere else in the app (Machinery A/C, GST Input/Output Credit,
 * Capital, Depreciation, Drawings, and the like). This app still has no
 * managed chart-of-accounts screen; a "ledger" line is just a name typed
 * once and offered back as a suggestion next time (see
 * Company.journalLedgerAccounts), the same pattern Ship To addresses and
 * Expense categories already use elsewhere.
 */
export type JournalAccountKind = "party" | "bank" | "cash" | "expense" | "ledger";

export interface JournalLine {
  id: ID;
  kind: JournalAccountKind;
  /** The party id for "party", the bank id for "bank". For "expense" and
   *  "ledger" — which name a category/account string rather than a real
   *  document — this holds that same string as refName, so the generic
   *  "every non-cash line needs a refId" validation applies uniformly.
   *  Absent for "cash" — there is only one cash drawer, nothing to pick. */
  refId?: string;
  /** Snapshotted display name at the time this was posted — the party's
   *  name, the bank's name, the expense category, the ledger account name,
   *  or "Cash" — so a renamed or deleted party/bank/category doesn't leave
   *  this line unreadable. */
  refName: string;
  /**
   * Standard double-entry direction, uniform across all four kinds: a Debit
   * increases the account's own natural balance (a party owes more, a bank
   * or cash balance goes up, an expense is recognised); a Credit decreases
   * it. Exactly one of debit/credit is non-zero per line — this is the one
   * place in the app that uses formal accounting terms directly, because a
   * Journal Voucher is explicitly a tool for someone who already thinks in
   * them.
   *
   * Bank's OWN ledger view (buildBankLedger) displays money in/out the other
   * way round — as a passbook does, "Credit = deposit" — so a bank line's
   * debit/credit is inverted when read into that specific view. Every other
   * reader (netPartyPositions, cashFlows, the P&L) uses debit/credit exactly
   * as written here, with no inversion.
   */
  debit: number;
  credit: number;
  /** Optional per-line note — what THIS line is for, distinct from the
   *  voucher's own required narration (why the WHOLE entry exists). Matches
   *  the Description column the client's reference software prints next to
   *  every line, e.g. "Being machinery purchased on credit". */
  description?: string;
  /**
   * Bill-wise adjustment against specific outstanding Sale/Purchase
   * invoices for this same party — only meaningful for kind === "party".
   * Optional: a party line with none just moves their overall balance,
   * exactly as it always did.
   *
   * Reuses the exact mechanism `Payment.allocations` already uses to settle
   * an invoice (incrementing that document's own `paid` field) rather than
   * inventing a second, parallel way to mark a bill settled — the same
   * invoice's outstanding amount must read the same everywhere regardless
   * of whether it was closed by a Payment or by a Journal Voucher.
   */
  allocations?: JournalAllocation[];
}

/** One line's bill-wise tie to a specific invoice — the JV equivalent of
 *  PaymentAllocation. Kept as its own type (rather than reusing
 *  PaymentAllocation directly) because a JV party-line, unlike a Payment
 *  (always either "in" against Sales or "out" against Purchases), can
 *  touch either side for the same party, so `docKind` says which repo
 *  `docId` belongs to. */
export interface JournalAllocation {
  docId: ID;
  docKind: "sale" | "purchase";
  number: string;
  amount: number;
}

export interface JournalVoucher {
  id: ID;
  /** Its own series — never shares a series with any invoice/note. */
  number: string;
  date: string;
  /** Required: unlike every other document here, there are no line items to
   *  infer "why" from. */
  narration: string;
  /** Must net to zero — sum(debit) === sum(credit) — enforced at save time. */
  lines: JournalLine[];
  createdAt: string;
}

export type PrintFormat = "a4" | "a4-2up" | "thermal80" | "thermal58";

export interface Company {
  name: string;
  gstin?: string;
  phone?: string;
  email?: string;
  address?: string;
  currency: string;
  invoicePrefix: string;
  purchasePrefix: string;
  /** Own series for the pre-sale documents. Rule 46 wants the tax-invoice
   *  series consecutive, so nothing else may draw a number from it. */
  quotationPrefix?: string;
  proformaPrefix?: string;
  journalVoucherPrefix?: string;
  enableGst?: boolean;
  /**
   * What kind of billing this business actually does — sets the DEFAULT
   * GST state for a brand new invoice/quotation/return. Absent/"both" means
   * exactly today's behaviour: every new document defaults to GST on, and
   * the per-document toggle stays fully editable either way, same as before
   * this setting existed. "gst" defaults new documents to GST on; "non-gst"
   * defaults them off — in both cases the toggle is still there to correct
   * one single bill, since forcing it would mean editing an OLD invoice
   * could silently change under you. This never touches an existing
   * document's own saved gstEnabled.
   */
  gstMode?: "gst" | "non-gst" | "both";
  /** Round invoice totals to the nearest rupee (default on) */
  enableRoundOff?: boolean;
  /** Allow a sale/purchase-return to push item stock below zero (default on,
   * matching Vyapar/Tally — counter billing shouldn't block on stock entry
   * lagging behind). When turned off, such saves are blocked with an error
   * instead of just a warning. */
  allowNegativeStock?: boolean;
  /** Preferred print format, remembered from the invoice page */
  printFormat?: PrintFormat;
  /** Printing onto pre-printed letterhead stationery — remembered the same
   *  way printFormat is (persisted from the invoice page, selectable from
   *  Settings too), and only meaningful for the "a4"/"a4-2up" formats. */
  printOnLetterhead?: boolean;
  /** Set once the owner has finished checking existing opening balances
   * (Settings -> Opening Balance Review) and hidden that tool. Purely a UI
   * flag — it changes no number anywhere. */
  openingReviewDone?: boolean;
  /** The expense Category list — admin-managed from Settings, like a real
   * Chart of Accounts, rather than free text every user can invent on the
   * fly. Kept on Company (not its own repository) since it's a short,
   * stable list, unlike Payee which is meant to grow organically. */
  expenseCategories?: string[];
  /** Free-text "ledger" account names used in a Journal Voucher so far
   *  (Machinery A/C, GST Credit, Capital, ...) — grows automatically as new
   *  ones are typed, capped and most-recent-first, same pattern as a
   *  party's shipToHistory. Purely a suggestion list, not a managed master. */
  journalLedgerAccounts?: string[];
  /** The Unit of Measurement list — admin-managed from Settings, same reason
   *  and same pattern as expenseCategories: a short, stable list (PCS, KGS,
   *  METER, BOX...) the business defines once, not free text every counter
   *  can spell a different way each time ("Kg"/"KG"/"kgs" would otherwise
   *  split one unit into three in every stock/report screen). */
  units?: string[];
}

/** Matches the Sidebar's own groupings — permissions are granted per group,
 * not per individual page and not as fixed roles. Settings/Team management
 * is deliberately NOT a module here: it's owner-only everywhere, always,
 * so a staff member can never grant themselves broader access by editing
 * their own permissions. "reports" has no collection of its own (Reports/
 * Daybook/GST aggregate reads across the other modules, already protected
 * by their own rules) — it only gates the aggregated-view pages themselves. */
export type ModuleKey =
  | "masterData"
  | "sales"
  | "purchaseExpenses"
  | "cashBank"
  | "reports"
  | "documents";

export interface ModulePermission {
  view: boolean;
  edit: boolean;
  delete: boolean;
}

/** One doc per Firebase Auth UID. The account already using this app in
 * production becomes `isOwner: true` automatically the first time it loads
 * after this ships (see hydrateRepos) — existing behavior is unaffected. */
export interface TeamUser {
  id: string;
  email: string;
  name: string;
  /** Bypasses every permission check everywhere. Exactly one per business —
   * cannot be edited or deactivated by anyone, including another owner. */
  isOwner: boolean;
  /** false = fully locked out (deactivated, not deleted — see Settings/Team). */
  active: boolean;
  /** A module missing from this map means no access at all to it, not
   * "view only" — every level must be explicitly granted. */
  permissions: Partial<Record<ModuleKey, ModulePermission>>;
  createdAt: string;
}

/**
 * One piece of the business's own paperwork.
 *
 * The record, not the file. The file itself is in Firebase Storage at
 * `storagePath` — a scanned certificate is megabytes and a Firestore document
 * tops out at one — and keeping the record here is what lets the list load
 * and be searched offline without downloading anything.
 */
export interface BusinessDoc {
  id: ID;
  /** What the shop calls it: "GST Certificate", not "scan_004.pdf". */
  name: string;
  /** The file's own name, kept so a download arrives called what it was. */
  fileName: string;
  contentType?: string;
  size: number;
  /** Where the bytes are. See lib/businessDocs.ts — keyed by id, so renaming
   *  the document moves nothing and two files may share a name. */
  storagePath: string;
  note?: string;
  createdAt: string;
  createdBy?: string;
}

/**
 * A quotation or a proforma invoice.
 *
 * Deliberately the same shape as an Invoice from the party down, so the same
 * line editor and the same printed layout serve all three and a conversion is
 * a copy rather than a translation. What it does NOT have is the half that
 * makes an Invoice an accounting document: no paid, no paymentMode, no splits.
 * Those are absent because neither of these settles anything — see
 * lib/estimates.ts.
 */
export interface Estimate {
  id: ID;
  kind: EstimateKind;
  status: EstimateStatus;
  /** Its own series. Never a number from the tax-invoice series. */
  number: string;
  date: string;
  /** The price is only good until this date. */
  validUntil?: string;

  partyId: ID;
  partyName: string;
  partyPhone?: string;
  partyGstin?: string;
  partyAddress?: string;
  partyState?: string;
  placeOfSupply?: string;
  /** Same as Invoice.shipToAddress — quotations/proforma share InvoiceForm,
   *  so a quoted delivery address carries through if it's converted. */
  shipToAddress?: string;

  gstEnabled?: boolean;
  reverseCharge?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  discount: number;
  shippingCharge?: number;
  /** Same meaning as Invoice.additionalCharges — carries through if this
   *  quotation/proforma is converted to a real invoice. */
  additionalCharges?: AdditionalCharge[];
  taxAmount: number;
  /** Same meaning and reasoning as Invoice.taxCalcVersion. */
  taxCalcVersion?: 2;
  roundOff?: number;
  total: number;
  notes?: string;

  /** What this came from, and what it led to — the chain, read both ways. */
  fromId?: ID;
  fromNumber?: string;
  convertedToId?: ID;
  convertedToNumber?: string;
  /** Which kind of document it became: the next estimate, or the tax invoice. */
  convertedToKind?: EstimateKind | "invoice";

  createdAt: string;
}
