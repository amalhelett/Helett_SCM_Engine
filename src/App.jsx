import { useState, useMemo, useEffect } from "react";
import Papa from "papaparse";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FC_SHEET_ID = "1jZv_Qqeg2RWXssYroxyS3_fCW_D09Nqhbf6Px9s6pR4";

// ─── THEME ────────────────────────────────────────────────────────────────────
const T = {
  bg:     "#06060f",
  surf:   "#0b0b1a",
  card:   "#0f0f1f",
  border: "#1c1c32",
  bdH:    "#2c2c48",
  text:   "#a8b4cc",
  bright: "#dde6f8",
  dim:    "#424d62",
  accent: "#f5a623",
  green:  "#10b981",
  yellow: "#f59e0b",
  red:    "#ef4444",
  blue:   "#60a5fa",
  purple: "#a78bfa",
  teal:   "#2dd4bf",
};

const S = {
  SAFE:    { color: T.green,  bg: "rgba(16,185,129,.1)",  label: "SAFE"    },
  REORDER: { color: T.yellow, bg: "rgba(245,159,11,.1)",  label: "REORDER" },
  URGENT:  { color: T.red,    bg: "rgba(239,68,68,.1)",   label: "URGENT"  },
};

// ─── INFO CONTENT ─────────────────────────────────────────────────────────────
const INFO = {
  dashboard: {
    title: "Dashboard — Inventory Health Overview",
    body: `This page gives you a combined view of every SKU's health across both Amazon FBA and your local FC warehouse.

STATUS LOGIC (based on FBA stock vs your FC→FBA lead time):
  • SAFE    → FBA stock lasts longer than your FC→FBA lead time + buffer
  • REORDER → FBA stock will run out within lead time + buffer — start a shipment soon
  • URGENT  → FBA stock will run out before your next shipment can arrive — act immediately

COLUMNS:
  • FBA Avail     — Units available for sale on Amazon right now
  • In Transit    — Units you've already shipped from FC, currently traveling to Amazon
  • FC Sellable   — Units physically in your warehouse, ready to ship
  • Daily Sales   — Avg units sold per day (from Inventory Ledger if available, else FBA 30d data)
  • FBA Days Left — How long current FBA stock + in-transit will last at current velocity
  • Total Days    — How long ALL stock (FBA + FC) will last

SLIDERS (top bar):
  • FC→FBA Lead Time  — Days from dispatching from your FC to being live on Amazon
  • China Lead Time   — Days from placing order with supplier to receiving in your FC
  • Buffer Days       — Safety margin added on top of lead time before triggering alerts
  
Click any row to open the full SKU breakdown.`,
  },
  purchase: {
    title: "Purchase Order — What to Buy from China",
    body: `This page answers: "Do I need to place a new purchase order with my China supplier, and for how many units?"

It looks at your TOTAL stock across everywhere — FBA available, FBA in-transit, and your FC warehouse — and compares it against how long your China lead time takes.

DECISION LOGIC:
  If Total Stock < (Daily Sales × China Lead Time) → you're at risk before the order arrives
  Order Qty = (Daily Sales × (China Lead Time + Reorder Cycle)) − Total Stock

STATUS here is based on TOTAL stock (FBA + FC + in-transit), not just FBA.

SLIDERS THAT AFFECT THIS PAGE:
  • China Lead Time    — If your supplier takes 75 days, set this to 75. This is the key driver.
  • Buffer Days        — Extra safety cushion (e.g. 15 days for customs delays, QC holds)
  • Reorder Cycle      — How many days of stock each order should cover (e.g. 60 = 2-month supply)

FORMULA:
  Total Stock = FBA Available + FBA In-Transit + FC Sellable
  Total Days  = Total Stock ÷ Daily Sales
  Order Qty   = max(0, Daily Sales × (China Lead Time + Reorder Cycle) − Total Stock)
  
NOTE: "Planned Shipment" (inbound-working in Amazon) = units earmarked for FBA but still at your FC. These ARE included in Total Stock.`,
  },
  fba: {
    title: "Send to FBA — What to Ship from Your FC to Amazon",
    body: `This page answers: "How much stock should I pull from my FC and send to Amazon FBA right now?"

It only looks at FBA stock (not FC) and calculates the gap vs your FC→FBA lead time.

DECISION LOGIC:
  FBA Stock   = FBA Available + Units In-Transit to FBA (already shipped, not yet received)
  FBA Days    = FBA Stock ÷ Daily Sales
  If FBA Days < FC→FBA Lead Time + Buffer → you need to send more stock
  Send Qty    = max(0, Daily Sales × (FC→FBA Lead Time + Buffer) − FBA Stock)
  
  The app also caps this at your FC Sellable stock — you can't send what you don't have.

SLIDERS THAT AFFECT THIS PAGE:
  • FC→FBA Lead Time  — Days from dispatch at your FC to live on Amazon (typically 7–14 days)
  • Buffer Days        — Extra safety stock to always keep at FBA

DISTRIBUTION (bottom section):
  After deciding how many units to send, the distribution table shows which Amazon FC 
  (BLR8, CJB1, DEX3, etc.) should receive how many units — calculated from historical 
  customer shipment patterns per warehouse from your Inventory Ledger.
  This is 100% demand-based, never stock-based.`,
  },
};

// ─── PARSERS ──────────────────────────────────────────────────────────────────
function parseFBA(text) {
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
  return data.map(r => ({
    asin:         (r.asin        || "").trim(),
    fnsku:        (r.fnsku       || "").trim(),
    sku:          (r.sku         || "").trim(),
    name:         (r["product-name"] || "").trim(),
    available:    +r.available   || 0,
    // inbound-working = planned shipment, still at seller's warehouse
    inbWorking:   +r["inbound-working"]  || 0,
    // inbound-shipped = dispatched to FBA, in transit
    inbShipped:   +r["inbound-shipped"]  || 0,
    // inbound-received = arrived at FBA warehouse, being processed
    inbReceived:  +r["inbound-received"] || 0,
    resvFCXfer:   +r["Reserved FC Transfer"]   || 0,
    resvFCProc:   +r["Reserved FC Processing"] || 0,
    resvCustOrd:  +r["Reserved Customer Order"]|| 0,
    reserved:     +r["Total Reserved Quantity"]|| 0,
    unfulfillable:+r["unfulfillable-quantity"] || 0,
    t7:   +r["units-shipped-t7"]  || 0,
    t30:  +r["units-shipped-t30"] || 0,
    t60:  +r["units-shipped-t60"] || 0,
  })).filter(r => r.asin);
}

function parseLedger(text) {
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
  return data.map(r => ({
    date:      (r.Date         || "").trim(),
    fnsku:     (r.FNSKU        || "").trim(),
    asin:      (r.ASIN         || "").trim(),
    location:  (r.Location     || "").trim(),
    shipments: +r["Customer Shipments"] || 0,
    returns:   +r["Customer Returns"]   || 0,
  })).filter(r => r.asin || r.fnsku);
}

function parseShipments(text) {
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
  return data.map(r => ({
    msku: (r["Merchant SKU"] || "").trim(),
    qty:  +r["Shipped Quantity"] || 0,
    fc:   (r.FC               || "").trim(),
  })).filter(r => r.msku && r.qty > 0);
}

// Parse raw (no header) CSVs — for Google Sheets positional reads
function parseRawCSV(text) {
  const { data } = Papa.parse(text, { skipEmptyLines: false });
  return data;
}

// Sellable_Inventory: ASIN = col B (idx 1), Sellable stock = col C (idx 2), data from row 3 (idx 2)
function parseSellableFC(text) {
  const rows = parseRawCSV(text);
  const map = {};
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const asin  = (r[1] || "").toString().trim();
    const stock = parseInt(r[2]) || 0;
    if (/^B[A-Z0-9]{9}$/.test(asin)) map[asin] = stock;
  }
  return map;
}

// Unsellable: ASIN = col D (idx 3), count = LAST col, data from row 4 (idx 3)
function parseUnsellableFC(text) {
  const rows = parseRawCSV(text);
  const map = {};
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 4) continue;
    const asin  = (r[3] || "").toString().trim();
    const stock = parseInt(r[r.length - 1]) || 0;
    if (/^B[A-Z0-9]{9}$/.test(asin)) map[asin] = (map[asin] || 0) + stock;
  }
  return map;
}

// ─── CALC ENGINE ──────────────────────────────────────────────────────────────
function buildInventory(fba, ledger, shipments, fcSell, fcUnsell, params) {
  const { chinaLeadTime, fbaLeadTime, bufferDays, reorderCycle } = params;

  const fnskuToAsin = {};
  fba.forEach(r => { if (r.fnsku) fnskuToAsin[r.fnsku] = r.asin; });
  const skuToAsin = {};
  fba.forEach(r => { if (r.sku) skuToAsin[r.sku.toLowerCase()] = r.asin; });

  // Aggregate ledger
  const ledAsin = {};
  const ledFC   = {};
  ledger.forEach(row => {
    const asin = row.asin || fnskuToAsin[row.fnsku];
    if (!asin) return;
    const sold = Math.abs(Math.min(row.shipments, 0));
    const ret  = Math.max(row.returns, 0);
    if (!ledAsin[asin]) ledAsin[asin] = { sold: 0, returns: 0, dates: new Set() };
    ledAsin[asin].sold    += sold;
    ledAsin[asin].returns += ret;
    if (row.date) ledAsin[asin].dates.add(row.date);
    if (row.location && sold > 0) {
      if (!ledFC[asin]) ledFC[asin] = {};
      ledFC[asin][row.location] = (ledFC[asin][row.location] || 0) + sold;
    }
  });

  // Shipments FC fallback
  const shipFC = {};
  shipments.forEach(row => {
    const asin = skuToAsin[row.msku?.toLowerCase()];
    if (!asin || !row.fc) return;
    if (!shipFC[asin]) shipFC[asin] = {};
    shipFC[asin][row.fc] = (shipFC[asin][row.fc] || 0) + row.qty;
  });

  function ledDays(asin) {
    const e = ledAsin[asin];
    if (!e || e.dates.size < 2) return 30;
    const ts = [...e.dates].map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    if (ts.length < 2) return 30;
    return Math.max((Math.max(...ts) - Math.min(...ts)) / 86400000, 1);
  }

  return fba.map(item => {
    const asin = item.asin;
    const led  = ledAsin[asin];

    // Daily velocity
    let dailySales, salesSource;
    if (led && led.sold > 0) {
      dailySales  = Math.max((led.sold - led.returns) / ledDays(asin), 0);
      salesSource = "ledger";
    } else {
      dailySales  = Math.max(item.t30 / 30, 0);
      salesSource = "fba_t30";
    }
    dailySales = Math.round(dailySales * 100) / 100;

    // Stock components
    const fbaAvail    = item.available;
    // In-transit = shipped to FBA + received at FBA being processed
    const fbaInTrans  = item.inbShipped + item.inbReceived;
    // Planned = still at seller/FC, just earmarked in Amazon shipment plan
    const fbaPlanned  = item.inbWorking;
    const fcSellable  = fcSell[asin]   || 0;
    const fcUnsellable= fcUnsell[asin] || 0;

    // FBA stock for replenishment decisions (what Amazon actually has or is receiving)
    const fbaStock    = fbaAvail + fbaInTrans;

    // Total stock for purchase decisions (everything physical)
    // fbaPlanned is at FC but earmarked — only count if NOT already in fcSellable
    // (safest: count it, user can verify. Label clearly.)
    const totalStock  = fbaAvail + fbaInTrans + fbaPlanned + fcSellable;

    // DOI
    const fbaDOI   = dailySales > 0 ? Math.round((fbaStock  / dailySales) * 10) / 10 : 9999;
    const totalDOI = dailySales > 0 ? Math.round((totalStock / dailySales) * 10) / 10 : 9999;

    // Status
    const fbaStatus = fbaDOI < fbaLeadTime ? "URGENT"
      : fbaDOI < fbaLeadTime + bufferDays ? "REORDER" : "SAFE";
    const purchaseStatus = totalDOI < chinaLeadTime ? "URGENT"
      : totalDOI < chinaLeadTime + bufferDays ? "REORDER" : "SAFE";

    // Suggested send qty (FC → FBA)
    const fbaTarget = Math.ceil(dailySales * (fbaLeadTime + bufferDays));
    const rawSendQty = Math.max(0, fbaTarget - fbaStock);
    const sendQty    = Math.min(rawSendQty, fcSellable); // can't exceed FC stock
    const sendShortfall = rawSendQty > fcSellable ? rawSendQty - fcSellable : 0; // how much short

    // Suggested purchase qty (China → FC)
    const purchaseTarget = Math.ceil(dailySales * (chinaLeadTime + reorderCycle));
    const purchaseQty    = Math.max(0, purchaseTarget - totalStock);

    // Stockout date (FBA)
    const today = new Date();
    const stockoutDate = dailySales > 0
      ? new Date(today.getTime() + Math.min(fbaDOI, 730) * 86400000)
        .toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })
      : "∞";

    // FC distribution
    const fcRaw = Object.keys(ledFC[asin] || {}).length > 0 ? ledFC[asin] : (shipFC[asin] || {});
    const totalFCSales = Object.values(fcRaw).reduce((a, b) => a + b, 0);
    const fcDist = Object.entries(fcRaw)
      .map(([fc, sales]) => ({ fc, sales, pct: totalFCSales > 0 ? (sales / totalFCSales) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct);

    return {
      asin, fnsku: item.fnsku, sku: item.sku, name: item.name,
      fbaAvail, fbaInTrans, fbaPlanned, fbaStock,
      fcSellable, fcUnsellable, totalStock,
      t7: item.t7, t30: item.t30, t60: item.t60,
      dailySales, salesSource,
      fbaDOI, totalDOI,
      fbaStatus, purchaseStatus,
      stockoutDate, sendQty, sendShortfall, purchaseQty,
      fcDist, totalFCSales,
      resvFCXfer:   item.resvFCXfer,
      resvFCProc:   item.resvFCProc,
      resvCustOrd:  item.resvCustOrd,
      reserved:     item.reserved,
      unfulfillable:item.unfulfillable,
    };
  });
}

// ─── ATOMS ────────────────────────────────────────────────────────────────────
function Pill({ status }) {
  const m = S[status] || S.SAFE;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: "1.2px",
      color: m.color, background: m.bg, border: `1px solid ${m.color}30` }}>
      {m.label}
    </span>
  );
}

function Mono({ v, dec, suf = "", col }) {
  const d = typeof v === "number" ? (dec != null ? v.toFixed(dec) : Math.round(v).toLocaleString("en-IN")) : v;
  return <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: col || T.bright }}>{d}{suf}</span>;
}

function TH({ ch, title }) {
  return (
    <th title={title} style={{ padding: "8px 10px", textAlign: "left", whiteSpace: "nowrap", fontSize: 9,
      fontWeight: 700, letterSpacing: "0.8px", color: T.dim, borderBottom: `1px solid ${T.border}`,
      cursor: title ? "help" : "default" }}>
      {ch}{title && <span style={{ color: T.dim, marginLeft: 3 }}>?</span>}
    </th>
  );
}

function TD({ children, style }) {
  return <td style={{ padding: "9px 10px", borderBottom: `1px solid ${T.border}15`, ...style }}>{children}</td>;
}

function Slider({ label, value, min, max, step = 1, suf = "d", onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: T.dim, fontSize: 10, width: 110, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        style={{ flex: 1, accentColor: T.accent, cursor: "pointer", height: 3 }} />
      <span style={{ color: T.accent, fontFamily: "'Space Mono',monospace", fontSize: 12, width: 46, textAlign: "right" }}>
        {value}{suf}
      </span>
    </div>
  );
}

function Stat({ label, value, sub, color = T.bright }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 18px" }}>
      <div style={{ color, fontFamily: "'Space Mono',monospace", fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      <div style={{ color: T.dim, fontSize: 9, letterSpacing: "1.5px", marginTop: 6 }}>{label}</div>
      {sub && <div style={{ color: T.dim, fontSize: 9, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── INFO BUTTON + MODAL ──────────────────────────────────────────────────────
function InfoBtn({ pageKey }) {
  const [open, setOpen] = useState(false);
  const info = INFO[pageKey];
  return (
    <>
      <button onClick={() => setOpen(true)} style={{
        background: "none", border: `1px solid ${T.border}`, borderRadius: "50%",
        width: 22, height: 22, color: T.dim, fontSize: 11, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }} title="What does this page do?">ℹ</button>
      {open && (
        <div style={{ position: "fixed", inset: 0, background: "#000c", zIndex: 9000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: T.surf, border: `1px solid ${T.bdH}`, borderRadius: 12,
            maxWidth: 620, width: "100%", padding: 28, maxHeight: "80vh", overflowY: "auto",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
              <div style={{ color: T.accent, fontWeight: 700, fontSize: 14 }}>{info.title}</div>
              <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: T.dim, fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>
            <pre style={{ color: T.text, fontSize: 12, lineHeight: 1.8, whiteSpace: "pre-wrap", fontFamily: "'Space Mono',monospace" }}>
              {info.body}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

// ─── SKU DETAIL MODAL ─────────────────────────────────────────────────────────
function SKUModal({ item, params, onClose }) {
  const [shipQty, setShipQty] = useState(() => item?.sendQty || 500);
  if (!item) return null;

  const alloc = item.fcDist.map(fc => ({
    ...fc, allocated: Math.round((fc.pct / 100) * shipQty),
  }));

  const velBars = [
    { label: "7d",     val: +(item.t7  / 7 ).toFixed(2) },
    { label: "30d",    val: +(item.t30 / 30).toFixed(2) },
    { label: "60d",    val: +(item.t60 / 60).toFixed(2) },
    { label: "Ledger", val: item.dailySales              },
  ];

  const sm = S[item.fbaStatus];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000dd", zIndex: 3000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: T.surf, border: `1px solid ${T.bdH}`, borderRadius: 12,
        width: "100%", maxWidth: 900, maxHeight: "92vh", overflowY: "auto", padding: 26 }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ color: T.dim, fontSize: 9, letterSpacing: 3, marginBottom: 4 }}>SKU DETAIL</div>
            <div style={{ color: T.bright, fontSize: 15, fontWeight: 700, maxWidth: 680 }}>{item.sku}</div>
            <div style={{ color: T.dim, fontSize: 10, fontFamily: "'Space Mono',monospace", marginTop: 4 }}>
              ASIN: {item.asin} &nbsp;·&nbsp; FNSKU: {item.fnsku}
            </div>
            {item.name && <div style={{ color: T.dim, fontSize: 10, marginTop: 3, maxWidth: 600 }}>{item.name}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <Pill status={item.fbaStatus} />
            <button onClick={onClose} style={{ background: "none", border: "none", color: T.dim, fontSize: 20, cursor: "pointer" }}>✕</button>
          </div>
        </div>

        {/* FBA Status banner */}
        <div style={{ background: sm.bg, border: `1px solid ${sm.color}25`, borderRadius: 8,
          padding: "12px 18px", marginBottom: 22, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ color: T.dim, fontSize: 8, letterSpacing: 1 }}>FBA STATUS</div>
            <div style={{ color: sm.color, fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>{item.fbaStatus}</div>
          </div>
          <div style={{ width: 1, height: 36, background: T.border }} />
          <div>
            <div style={{ color: T.dim, fontSize: 8, letterSpacing: 1 }}>FBA DAYS LEFT</div>
            <div style={{ color: sm.color, fontFamily: "'Space Mono',monospace", fontSize: 22, fontWeight: 700 }}>
              {item.fbaDOI >= 9999 ? "∞" : item.fbaDOI}
            </div>
          </div>
          <div style={{ width: 1, height: 36, background: T.border }} />
          <div>
            <div style={{ color: T.dim, fontSize: 8, letterSpacing: 1 }}>FBA STOCKOUT</div>
            <div style={{ color: T.bright, fontSize: 14, fontWeight: 600 }}>{item.stockoutDate}</div>
          </div>
          <div style={{ width: 1, height: 36, background: T.border }} />
          <div>
            <div style={{ color: T.dim, fontSize: 8, letterSpacing: 1 }}>TOTAL DAYS (ALL STOCK)</div>
            <div style={{ color: T.teal, fontFamily: "'Space Mono',monospace", fontSize: 22, fontWeight: 700 }}>
              {item.totalDOI >= 9999 ? "∞" : item.totalDOI}
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <div style={{ color: T.dim, fontSize: 8, letterSpacing: 1 }}>VELOCITY SOURCE</div>
            <div style={{ color: item.salesSource === "ledger" ? T.green : T.yellow, fontSize: 10, letterSpacing: 1 }}>
              {item.salesSource === "ledger" ? "📊 LEDGER" : "⚡ FBA 30d"}
            </div>
          </div>
        </div>

        {/* Two column breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 22 }}>
          {/* FBA Breakdown */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ color: T.blue, fontSize: 9, letterSpacing: 2, marginBottom: 12, fontWeight: 700 }}>📦 FBA STOCK BREAKDOWN</div>
            {[
              { l: "Available (live on Amazon)", v: item.fbaAvail,     c: T.blue   },
              { l: "In Transit to FBA",          v: item.fbaInTrans,   c: T.teal   },
              { l: "Planned Shipment (at FC)",   v: item.fbaPlanned,   c: T.dim    },
              { l: "FC Transfer (reserved)",     v: item.resvFCXfer,   c: T.text   },
              { l: "FC Processing (reserved)",   v: item.resvFCProc,   c: T.text   },
              { l: "Customer Orders (reserved)", v: item.resvCustOrd,  c: T.text   },
              { l: "Unfulfillable at FBA",       v: item.unfulfillable,c: T.red    },
            ].map(m => (
              <div key={m.l} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0",
                borderBottom: `1px solid ${T.border}20` }}>
                <span style={{ color: T.dim, fontSize: 10 }}>{m.l}</span>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: m.c }}>{m.v}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", marginTop: 2 }}>
              <span style={{ color: T.blue, fontSize: 10, fontWeight: 700 }}>FBA Stock (avail + in-transit)</span>
              <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, color: T.blue, fontWeight: 700 }}>
                {item.fbaStock}
              </span>
            </div>
          </div>

          {/* FC Breakdown */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ color: T.purple, fontSize: 9, letterSpacing: 2, marginBottom: 12, fontWeight: 700 }}>🏭 LOCAL FC STOCK</div>
            {[
              { l: "FC Sellable",    v: item.fcSellable,    c: T.green  },
              { l: "FC Unsellable",  v: item.fcUnsellable,  c: T.red    },
            ].map(m => (
              <div key={m.l} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0",
                borderBottom: `1px solid ${T.border}20` }}>
                <span style={{ color: T.dim, fontSize: 10 }}>{m.l}</span>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: m.c }}>{m.v}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", marginTop: 2, borderTop: `1px solid ${T.border}` }}>
              <span style={{ color: T.purple, fontSize: 10, fontWeight: 700 }}>Total All Stock</span>
              <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, color: T.purple, fontWeight: 700 }}>{item.totalStock}</span>
            </div>

            <div style={{ marginTop: 16, padding: "10px 0", borderTop: `1px solid ${T.border}` }}>
              <div style={{ color: T.dim, fontSize: 9, letterSpacing: 2, marginBottom: 10 }}>DAILY VELOCITY</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: T.dim, fontSize: 10 }}>Daily Sales</span>
                <span style={{ fontFamily: "'Space Mono',monospace", color: T.accent, fontWeight: 700, fontSize: 14 }}>{item.dailySales}/d</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: T.dim, fontSize: 10 }}>Suggest Send to FBA</span>
                <span style={{ fontFamily: "'Space Mono',monospace", color: item.sendQty > 0 ? T.teal : T.dim, fontWeight: 700, fontSize: 13 }}>{item.sendQty}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: T.dim, fontSize: 10 }}>Suggest Purchase (China)</span>
                <span style={{ fontFamily: "'Space Mono',monospace", color: item.purchaseQty > 0 ? T.accent : T.dim, fontWeight: 700, fontSize: 13 }}>{item.purchaseQty}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Velocity chart */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ color: T.dim, fontSize: 9, letterSpacing: 3, marginBottom: 10 }}>DAILY SALES VELOCITY COMPARISON</div>
          <div style={{ height: 120 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={velBars} barSize={40}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: T.dim, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: T.dim, fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: T.card, border: `1px solid ${T.border}`, fontSize: 11 }}
                  cursor={{ fill: T.border + "40" }} />
                <Bar dataKey="val" name="units/day" fill={T.accent} radius={[3, 3, 0, 0]}
                  label={{ position: "top", fill: T.accent, fontSize: 10, fontFamily: "'Space Mono',monospace" }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* FC Distribution planner */}
        <div>
          <div style={{ color: T.dim, fontSize: 9, letterSpacing: 3, marginBottom: 12 }}>
            FC DISTRIBUTION PLANNER — DEMAND BASED (which Amazon warehouses to send to)
          </div>
          {item.fcDist.length > 0 ? (
            <>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
                <span style={{ color: T.dim, fontSize: 11 }}>Units to distribute:</span>
                <input type="number" value={shipQty} onChange={e => setShipQty(+e.target.value)}
                  style={{ width: 110, padding: "6px 10px", borderRadius: 5, background: T.card,
                    border: `1px solid ${T.border}`, color: T.bright, fontFamily: "'Space Mono',monospace",
                    fontSize: 14, fontWeight: 700 }} />
                <span style={{ color: T.dim, fontSize: 10 }}>
                  Based on {item.totalFCSales} total historical sales across {item.fcDist.length} FCs
                </span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Amazon FC","Hist. Sales","Demand %","Units to Send","Bar"].map(h => <TH key={h} ch={h} />)}
                  </tr>
                </thead>
                <tbody>
                  {alloc.map(fc => (
                    <tr key={fc.fc}>
                      <TD><span style={{ fontFamily: "'Space Mono',monospace", fontSize: 14, fontWeight: 700, color: T.accent }}>{fc.fc}</span></TD>
                      <TD><Mono v={fc.sales} /></TD>
                      <TD><Mono v={fc.pct} dec={1} suf="%" /></TD>
                      <TD><span style={{ background: T.green, color: "#000", padding: "2px 10px", borderRadius: 3, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{fc.allocated}</span></TD>
                      <TD style={{ width: 160 }}>
                        <div style={{ background: T.border, borderRadius: 2, height: 6 }}>
                          <div style={{ width: `${Math.min(fc.pct, 100)}%`, height: "100%", background: T.green, borderRadius: 2 }} />
                        </div>
                      </TD>
                    </tr>
                  ))}
                  <tr style={{ borderTop: `1px solid ${T.border}` }}>
                    <TD><span style={{ color: T.dim, fontSize: 9 }}>TOTAL</span></TD>
                    <TD><Mono v={item.totalFCSales} /></TD>
                    <TD><Mono v={100} suf="%" /></TD>
                    <TD><span style={{ background: T.accent, color: "#000", padding: "2px 10px", borderRadius: 3, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{alloc.reduce((a, r) => a + r.allocated, 0)}</span></TD>
                    <TD />
                  </tr>
                </tbody>
              </table>
            </>
          ) : (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 20,
              textAlign: "center", color: T.dim, fontSize: 12 }}>
              No FC distribution data — upload Inventory Ledger or Shipments file
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PAGE: IMPORT ─────────────────────────────────────────────────────────────
function ImportPage({ fileStatus, onFile, onGS, onLaunch, hasData, fcAutoStatus, parseCount, parseErr, raw }) {
  const [gsUrl,  setGsUrl]  = useState(`https://docs.google.com/spreadsheets/d/${FC_SHEET_ID}/edit`);
  const [gsTab,  setGsTab]  = useState("FBA Inventory");
  const [gsType, setGsType] = useState("fba");
  const [gsErr,  setGsErr]  = useState("");
  const [gsLoading, setGsLoading] = useState(false);

  async function doFetch() {
    setGsLoading(true); setGsErr("");
    const m = gsUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) { setGsErr("Invalid URL"); setGsLoading(false); return; }
    const url = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&sheet=${encodeURIComponent(gsTab)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const text = await res.text();
      onGS(gsType, text);
    } catch {
      setGsErr("Failed – sheet must be public: Share → Anyone with link → Viewer");
    }
    setGsLoading(false);
  }

  const UpCard = ({ title, sub, icon, type, accent = T.accent }) => {
    const loaded = fileStatus[type] === "loaded";
    const fileRef = { current: null };
    return (
      <label style={{ display: "block", border: `1px solid ${loaded ? accent + "55" : T.border}`,
        borderRadius: 8, padding: 16, cursor: "pointer", background: loaded ? accent + "08" : T.card,
        position: "relative", transition: "border-color .2s" }}>
        <input type="file" accept=".csv,.xlsx" style={{ display: "none" }}
          onChange={e => e.target.files[0] && onFile(type, e.target.files[0])} />
        <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>
        <div style={{ color: T.bright, fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ color: T.dim, fontSize: 10, marginTop: 3 }}>{sub}</div>
        {loaded && <div style={{ position: "absolute", top: 10, right: 12, color: T.green, fontSize: 10, letterSpacing: 1 }}>✓ LOADED</div>}
      </label>
    );
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <div style={{ marginBottom: 32 }}>
        <div style={{ color: T.dim, fontSize: 9, letterSpacing: 4, marginBottom: 6 }}>HELETT SUPPLY CHAIN ENGINE</div>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: T.bright, letterSpacing: -0.5, margin: 0 }}>Data Import</h1>
        <p style={{ color: T.dim, fontSize: 12, marginTop: 6 }}>
          Your FC warehouse sheet (Sellable + Unsellable) is fetched automatically on every load.
        </p>
      </div>

      {/* Auto-fetched FC status */}
      <div style={{ background: T.card, border: `1px solid ${fcAutoStatus === "loaded" ? T.purple + "55" : T.border}`,
        borderRadius: 8, padding: 16, marginBottom: 20, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 24 }}>🏭</div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.bright, fontSize: 13, fontWeight: 600 }}>Local FC Warehouse Sheet</div>
          <div style={{ color: T.dim, fontSize: 10, marginTop: 2 }}>
            Auto-fetched from your Google Sheet · Sellable_Inventory + Unsellable tabs
          </div>
        </div>
        <div style={{ color: fcAutoStatus === "loaded" ? T.green : fcAutoStatus === "loading" ? T.yellow : T.red,
          fontSize: 10, fontFamily: "'Space Mono',monospace", letterSpacing: 1, textAlign: "right" }}>
          {fcAutoStatus === "loaded" ? "✓ LOADED" : fcAutoStatus === "loading" ? "⟳ LOADING..." : fcAutoStatus === "error" ? "⚠ FAILED" : "○ PENDING"}
        </div>
      </div>

      {/* GS connector */}
      <div style={{ background: T.card, border: `1px solid ${T.accent}30`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
        <div style={{ color: T.accent, fontSize: 9, letterSpacing: 3, marginBottom: 12 }}>⚡ GOOGLE SHEETS — FETCH ANY TAB</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 170px 150px 90px", gap: 8, marginBottom: 6 }}>
          <input value={gsUrl} onChange={e => setGsUrl(e.target.value)}
            style={{ padding: "8px 10px", borderRadius: 5, background: T.surf, border: `1px solid ${T.border}`, color: T.text, fontSize: 11 }} />
          <input value={gsTab} onChange={e => setGsTab(e.target.value)} placeholder="Tab name (exact)"
            style={{ padding: "8px 10px", borderRadius: 5, background: T.surf, border: `1px solid ${T.border}`, color: T.text, fontSize: 11 }} />
          <select value={gsType} onChange={e => setGsType(e.target.value)}
            style={{ padding: "8px 10px", borderRadius: 5, background: T.surf, border: `1px solid ${T.border}`, color: T.text, fontSize: 11 }}>
            <option value="fba">FBA Inventory</option>
            <option value="ledger">Inventory Ledger</option>
            <option value="shipments">Shipments</option>
          </select>
          <button onClick={doFetch} disabled={gsLoading}
            style={{ borderRadius: 5, border: "none", background: T.accent, color: "#000", fontWeight: 700, fontSize: 11, cursor: "pointer", opacity: gsLoading ? .6 : 1 }}>
            {gsLoading ? "…" : "FETCH"}
          </button>
        </div>
        {gsErr && <div style={{ color: T.red, fontSize: 10, marginTop: 4 }}>⚠ {gsErr}</div>}
      </div>

      {/* File uploads */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
        <UpCard title="FBA Inventory" sub="Seller Central → Manage FBA Inventory" icon="📦" type="fba" accent={T.accent} />
        <UpCard title="Inventory Ledger" sub="Reports → Fulfillment → Inventory Ledger" icon="📋" type="ledger" accent={T.green} />
        <UpCard title="Fulfilled Shipments" sub="Reports → Fulfillment → Amazon Fulfilled Shipments" icon="🚚" type="shipments" accent={T.blue} />
      </div>

      {/* Debug row counts */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: 16 }}>
        <div style={{ color: T.dim, fontSize: 9, letterSpacing: 3, marginBottom: 10 }}>DEBUG — PARSED ROW COUNTS</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[
            { key: "fba",       label: "FBA Inventory" },
            { key: "ledger",    label: "Inventory Ledger" },
            { key: "shipments", label: "Fulfilled Shipments" },
          ].map(({ key, label }) => (
            <div key={key} style={{ background: T.surf, borderRadius: 6, padding: "10px 14px" }}>
              <div style={{ color: T.dim, fontSize: 9, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 18, fontWeight: 700,
                color: fileStatus[key] === "loaded" ? T.green : fileStatus[key] === "error" ? T.red : T.dim }}>
                {fileStatus[key] === "loaded" ? `${parseCount[key]} rows` : fileStatus[key] === "error" ? "ERROR" : fileStatus[key] === "loading" ? "loading…" : "—"}
              </div>
              {fileStatus[key] === "error" && parseErr[key] && (
                <div style={{ color: T.red, fontSize: 9, marginTop: 4, lineHeight: 1.4 }}>{parseErr[key]}</div>
              )}
            </div>
          ))}
        </div>
        {!hasData && fileStatus.fba === "loaded" && (
          <div style={{ marginTop: 10, color: T.red, fontSize: 11 }}>
            ⚠ FBA file shows LOADED but parsed 0 rows — the sheet may not be returning CSV. Make sure the tab name is exact and the sheet is shared publicly.
          </div>
        )}
      </div>

      <button
        onClick={onLaunch}
        disabled={!hasData}
        style={{
          width: "100%", padding: 13, borderRadius: 8, border: "none",
          cursor: hasData ? "pointer" : "not-allowed",
          background: hasData ? `linear-gradient(135deg, ${T.accent}, #d4891e)` : T.border,
          color: hasData ? "#000" : T.dim,
          fontWeight: 700, fontSize: 13, letterSpacing: 1,
          transition: "all .2s",
        }}>
        {hasData ? `LAUNCH DASHBOARD → (${raw.fba.length} SKUs loaded)` : "LAUNCH DASHBOARD → (load FBA Inventory first)"}
      </button>
    </div>
  );
}

// ─── PAGE: DASHBOARD ──────────────────────────────────────────────────────────
function DashboardPage({ inv, params, onSelect }) {
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    let d = [...inv];
    if (filter === "URGENT")  d = d.filter(r => r.fbaStatus === "URGENT");
    if (filter === "REORDER") d = d.filter(r => r.fbaStatus === "REORDER");
    if (filter === "ACTION")  d = d.filter(r => r.fbaStatus !== "SAFE");
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(r => r.sku?.toLowerCase().includes(q) || r.asin?.toLowerCase().includes(q));
    }
    return d.sort((a, b) => ({ URGENT: 0, REORDER: 1, SAFE: 2 }[a.fbaStatus] - { URGENT: 0, REORDER: 1, SAFE: 2 }[b.fbaStatus]) || a.fbaDOI - b.fbaDOI);
  }, [inv, filter, search]);

  const counts = useMemo(() => ({
    total: inv.length,
    urgent: inv.filter(r => r.fbaStatus === "URGENT").length,
    reorder: inv.filter(r => r.fbaStatus === "REORDER").length,
    safe: inv.filter(r => r.fbaStatus === "SAFE").length,
    sendNeeded: inv.filter(r => r.sendQty > 0).length,
  }), [inv]);

  const doiCol = (d) => d < params.fbaLeadTime ? T.red : d < params.fbaLeadTime + params.bufferDays ? T.yellow : T.green;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: T.bright, margin: 0 }}>Inventory Health Overview</h2>
        <InfoBtn pageKey="dashboard" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, marginBottom: 18 }}>
        <Stat label="TOTAL SKUs"    value={counts.total}      color={T.bright} />
        <Stat label="URGENT"        value={counts.urgent}     color={T.red}    />
        <Stat label="REORDER"       value={counts.reorder}    color={T.yellow} />
        <Stat label="SAFE"          value={counts.safe}       color={T.green}  />
        <Stat label="NEED SEND→FBA" value={counts.sendNeeded} color={T.teal}   />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {["ALL","ACTION","URGENT","REORDER"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "4px 13px", borderRadius: 4, border: `1px solid ${filter===f ? T.accent : T.border}`,
            background: filter===f ? T.accent : "transparent", color: filter===f ? "#000" : T.dim,
            fontSize: 9, fontWeight: 700, letterSpacing: "1.2px", cursor: "pointer",
          }}>{f}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search SKU or ASIN…"
          style={{ marginLeft: "auto", padding: "6px 11px", borderRadius: 4, background: T.card,
            border: `1px solid ${T.border}`, color: T.text, fontSize: 11, width: 230 }} />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: T.surf }}>
              <TH ch="SKU / Product" />
              <TH ch="ASIN" />
              <TH ch="STATUS" title="Based on FBA days left vs FC→FBA lead time" />
              <TH ch="FBA Avail" title="Units live on Amazon" />
              <TH ch="In Transit" title="Shipped from FC, traveling to Amazon" />
              <TH ch="FC Sellable" title="Units in your warehouse, ready to send" />
              <TH ch="FC Unsellable" title="Damaged/defective stock at FC" />
              <TH ch="Daily Sales" title="Avg units/day (ledger preferred)" />
              <TH ch="FBA Days" title="How long FBA stock alone lasts" />
              <TH ch="Total Days" title="How long all stock (FBA+FC) lasts" />
              <TH ch="FBA Stockout" />
              <TH ch="Send→FBA" title="Suggested units to dispatch from FC now" />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.asin} onClick={() => onSelect(r.asin)} style={{ cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = T.border + "30"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <TD>
                  <div style={{ color: T.accent, fontWeight: 600, fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku}</div>
                  <div style={{ color: T.dim, fontSize: 9, marginTop: 1, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                </TD>
                <TD><span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: T.dim }}>{r.asin}</span></TD>
                <TD><Pill status={r.fbaStatus} /></TD>
                <TD><Mono v={r.fbaAvail} col={r.fbaAvail < 20 ? T.red : T.bright} /></TD>
                <TD><Mono v={r.fbaInTrans} col={r.fbaInTrans > 0 ? T.teal : T.dim} /></TD>
                <TD><Mono v={r.fcSellable} col={r.fcSellable > 0 ? T.purple : T.dim} /></TD>
                <TD><Mono v={r.fcUnsellable} col={r.fcUnsellable > 0 ? T.red : T.dim} /></TD>
                <TD><Mono v={r.dailySales} dec={1} suf="/d" /></TD>
                <TD><Mono v={r.fbaDOI >= 9999 ? "∞" : r.fbaDOI} col={doiCol(r.fbaDOI)} /></TD>
                <TD><Mono v={r.totalDOI >= 9999 ? "∞" : r.totalDOI} col={T.teal} /></TD>
                <TD><span style={{ fontSize: 10, color: T.dim }}>{r.stockoutDate}</span></TD>
                <TD>
                  {r.sendQty > 0 ? (
                    <span style={{ background: T.teal + "22", color: T.teal, padding: "2px 8px", borderRadius: 3,
                      fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 11, border: `1px solid ${T.teal}40` }}>
                      {r.sendQty}{r.sendShortfall > 0 ? ` ⚠` : ""}
                    </span>
                  ) : <Mono v="—" col={T.dim} />}
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div style={{ textAlign: "center", padding: 50, color: T.dim }}>No SKUs match the filter</div>
        )}
      </div>
    </div>
  );
}

// ─── PAGE: PURCHASE ORDER (China → FC) ───────────────────────────────────────
function PurchasePage({ inv, params }) {
  const [filter, setFilter] = useState("NEEDS_ORDER");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    let d = [...inv];
    if (filter === "URGENT")     d = d.filter(r => r.purchaseStatus === "URGENT");
    if (filter === "REORDER")    d = d.filter(r => r.purchaseStatus === "REORDER");
    if (filter === "NEEDS_ORDER")d = d.filter(r => r.purchaseQty > 0);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(r => r.sku?.toLowerCase().includes(q) || r.asin?.toLowerCase().includes(q));
    }
    return d.sort((a, b) => ({ URGENT: 0, REORDER: 1, SAFE: 2 }[a.purchaseStatus] - { URGENT: 0, REORDER: 1, SAFE: 2 }[b.purchaseStatus]) || a.totalDOI - b.totalDOI);
  }, [inv, filter, search]);

  const totalUnits = rows.reduce((a, r) => a + r.purchaseQty, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: T.bright, margin: 0 }}>
          Purchase Order &nbsp;<span style={{ color: T.dim, fontWeight: 400, fontSize: 13 }}>China → Your FC</span>
        </h2>
        <InfoBtn pageKey="purchase" />
      </div>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: "10px 16px", marginBottom: 18 }}>
        <span style={{ color: T.dim, fontSize: 11 }}>
          STATUS on this page = based on <strong style={{ color: T.bright }}>TOTAL stock (FBA + FC + in-transit)</strong> vs your{" "}
          <strong style={{ color: T.accent }}>China lead time ({params.chinaLeadTime}d)</strong>.{" "}
          The question here is: <em style={{ color: T.teal }}>do I have enough stock to last until my next China order arrives?</em>
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center" }}>
        {["NEEDS_ORDER","URGENT","REORDER","ALL"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "4px 13px", borderRadius: 4, border: `1px solid ${filter===f ? T.accent : T.border}`,
            background: filter===f ? T.accent : "transparent", color: filter===f ? "#000" : T.dim,
            fontSize: 9, fontWeight: 700, letterSpacing: "1.2px", cursor: "pointer",
          }}>{f.replace("_"," ")}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU…"
          style={{ marginLeft: "auto", padding: "6px 11px", borderRadius: 4, background: T.card,
            border: `1px solid ${T.border}`, color: T.text, fontSize: 11, width: 200 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span style={{ color: T.dim, fontSize: 11 }}>{rows.length} SKUs · Total:</span>
          <span style={{ color: T.accent, fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14 }}>
            {totalUnits.toLocaleString("en-IN")} units
          </span>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: T.surf }}>
              <TH ch="SKU" />
              <TH ch="ASIN" />
              <TH ch="PURCHASE STATUS" title="Based on total stock vs China lead time" />
              <TH ch="FBA Stock" title="FBA available + in-transit" />
              <TH ch="FC Sellable" />
              <TH ch="Total Stock" title="FBA + FC + planned shipments" />
              <TH ch="Daily Sales" />
              <TH ch="Total Days" title="How long all stock lasts" />
              <TH ch="China Days Gap" title="Total days vs China lead time. Negative = at risk" />
              <TH ch="ORDER QTY" title="How many units to order from China" />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const gap = r.totalDOI >= 9999 ? 9999 : r.totalDOI - params.chinaLeadTime;
              return (
                <tr key={r.asin} style={{ borderBottom: `1px solid ${T.border}15` }}>
                  <TD>
                    <div style={{ color: T.accent, fontWeight: 600, fontSize: 12, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku}</div>
                  </TD>
                  <TD><span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: T.dim }}>{r.asin}</span></TD>
                  <TD><Pill status={r.purchaseStatus} /></TD>
                  <TD><Mono v={r.fbaStock} /></TD>
                  <TD><Mono v={r.fcSellable} col={r.fcSellable > 0 ? T.purple : T.dim} /></TD>
                  <TD><Mono v={r.totalStock} col={T.teal} /></TD>
                  <TD><Mono v={r.dailySales} dec={1} suf="/d" /></TD>
                  <TD><Mono v={r.totalDOI >= 9999 ? "∞" : r.totalDOI} col={r.purchaseStatus === "URGENT" ? T.red : r.purchaseStatus === "REORDER" ? T.yellow : T.green} /></TD>
                  <TD>
                    <Mono v={gap >= 9999 ? "∞" : (gap > 0 ? "+" + Math.round(gap) : Math.round(gap))} suf={gap < 9999 ? "d" : ""}
                      col={gap < 0 ? T.red : gap < params.bufferDays ? T.yellow : T.green} />
                  </TD>
                  <TD>
                    {r.purchaseQty > 0 ? (
                      <span style={{ background: T.accent, color: "#000", padding: "3px 10px", borderRadius: 3,
                        fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13 }}>
                        {r.purchaseQty.toLocaleString("en-IN")}
                      </span>
                    ) : <Mono v="—" col={T.dim} />}
                  </TD>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div style={{ textAlign: "center", padding: 40, color: T.dim }}>No items match filter</div>}
      </div>
    </div>
  );
}

// ─── PAGE: SEND TO FBA (FC → FBA + Distribution) ─────────────────────────────
function FBAPage({ inv, params }) {
  const [filter, setFilter] = useState("NEEDS_SEND");
  const [search, setSearch] = useState("");
  const [distAsin, setDistAsin] = useState("");
  const [distQty, setDistQty] = useState(500);
  const [tab, setTab] = useState("replen");

  const rows = useMemo(() => {
    let d = [...inv];
    if (filter === "URGENT")    d = d.filter(r => r.fbaStatus === "URGENT");
    if (filter === "REORDER")   d = d.filter(r => r.fbaStatus === "REORDER");
    if (filter === "NEEDS_SEND")d = d.filter(r => r.sendQty > 0);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(r => r.sku?.toLowerCase().includes(q) || r.asin?.toLowerCase().includes(q));
    }
    return d.sort((a, b) => ({ URGENT: 0, REORDER: 1, SAFE: 2 }[a.fbaStatus] - { URGENT: 0, REORDER: 1, SAFE: 2 }[b.fbaStatus]) || a.fbaDOI - b.fbaDOI);
  }, [inv, filter, search]);

  const totalSend = rows.reduce((a, r) => a + r.sendQty, 0);

  const distItem = useMemo(() => inv.find(r => r.asin === distAsin), [inv, distAsin]);
  const distAlloc = useMemo(() => distItem
    ? distItem.fcDist.map(fc => ({ ...fc, allocated: Math.round((fc.pct / 100) * distQty) }))
    : [], [distItem, distQty]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: T.bright, margin: 0 }}>
          Send to FBA &nbsp;<span style={{ color: T.dim, fontWeight: 400, fontSize: 13 }}>Your FC → Amazon FBA</span>
        </h2>
        <InfoBtn pageKey="fba" />
      </div>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: "10px 16px", marginBottom: 18 }}>
        <span style={{ color: T.dim, fontSize: 11 }}>
          STATUS here = based on <strong style={{ color: T.bright }}>FBA stock only</strong> vs your{" "}
          <strong style={{ color: T.teal }}>FC→FBA lead time ({params.fbaLeadTime}d)</strong>.{" "}
          The question: <em style={{ color: T.teal }}>which SKUs need stock dispatched from my FC to Amazon now?</em>{" "}
          Send Qty is capped at available FC sellable stock.
        </span>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 18, borderBottom: `1px solid ${T.border}` }}>
        {[{ id: "replen", l: "Replenishment List" }, { id: "dist", l: "Warehouse Distribution" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "8px 18px", border: "none", background: "transparent", cursor: "pointer",
            color: tab === t.id ? T.accent : T.dim, fontSize: 12, fontWeight: 600,
            borderBottom: `2px solid ${tab === t.id ? T.accent : "transparent"}`,
            marginBottom: -1,
          }}>{t.l}</button>
        ))}
      </div>

      {tab === "replen" && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center" }}>
            {["NEEDS_SEND","URGENT","REORDER","ALL"].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: "4px 13px", borderRadius: 4, border: `1px solid ${filter===f ? T.teal : T.border}`,
                background: filter===f ? T.teal : "transparent", color: filter===f ? "#000" : T.dim,
                fontSize: 9, fontWeight: 700, letterSpacing: "1.2px", cursor: "pointer",
              }}>{f.replace("_"," ")}</button>
            ))}
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU…"
              style={{ marginLeft: "auto", padding: "6px 11px", borderRadius: 4, background: T.card,
                border: `1px solid ${T.border}`, color: T.text, fontSize: 11, width: 200 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ color: T.dim, fontSize: 11 }}>Total dispatch:</span>
              <span style={{ color: T.teal, fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14 }}>
                {totalSend.toLocaleString("en-IN")} units
              </span>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: T.surf }}>
                  <TH ch="SKU" />
                  <TH ch="ASIN" />
                  <TH ch="FBA STATUS" />
                  <TH ch="FBA Avail" title="Live on Amazon" />
                  <TH ch="In Transit" title="Already shipped from FC to Amazon" />
                  <TH ch="FBA Days" title="How long FBA stock lasts" />
                  <TH ch="FC Sellable" title="Available in your warehouse to send" />
                  <TH ch="Daily Sales" />
                  <TH ch="SEND QTY" title="Send this many from FC to FBA now" />
                  <TH ch="FC Shortfall" title="How much FC stock is short of what FBA needs" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.asin} style={{ borderBottom: `1px solid ${T.border}15` }}>
                    <TD>
                      <div style={{ color: T.accent, fontWeight: 600, fontSize: 12, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku}</div>
                    </TD>
                    <TD><span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: T.dim }}>{r.asin}</span></TD>
                    <TD><Pill status={r.fbaStatus} /></TD>
                    <TD><Mono v={r.fbaAvail} col={r.fbaAvail < 20 ? T.red : T.bright} /></TD>
                    <TD><Mono v={r.fbaInTrans} col={r.fbaInTrans > 0 ? T.teal : T.dim} /></TD>
                    <TD>
                      <Mono v={r.fbaDOI >= 9999 ? "∞" : r.fbaDOI}
                        col={r.fbaDOI < params.fbaLeadTime ? T.red : r.fbaDOI < params.fbaLeadTime + params.bufferDays ? T.yellow : T.green} />
                    </TD>
                    <TD><Mono v={r.fcSellable} col={r.fcSellable > 0 ? T.purple : T.dim} /></TD>
                    <TD><Mono v={r.dailySales} dec={1} suf="/d" /></TD>
                    <TD>
                      {r.sendQty > 0 ? (
                        <span style={{ background: T.teal, color: "#000", padding: "3px 10px", borderRadius: 3,
                          fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13 }}>
                          {r.sendQty}
                        </span>
                      ) : <Mono v="—" col={T.dim} />}
                    </TD>
                    <TD>
                      {r.sendShortfall > 0 ? (
                        <span style={{ color: T.red, fontFamily: "'Space Mono',monospace", fontSize: 11 }}>
                          −{r.sendShortfall}
                        </span>
                      ) : <Mono v="—" col={T.dim} />}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div style={{ textAlign: "center", padding: 40, color: T.dim }}>No items match filter</div>}
          </div>
        </>
      )}

      {tab === "dist" && (
        <div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: 18, color: T.dim, fontSize: 11, lineHeight: 1.7 }}>
            Once you decide how many units to send to Amazon, this tool splits them across the correct Amazon FCs
            (BLR8, CJB1, DEX3, etc.) based on <strong style={{ color: T.bright }}>historical customer demand per warehouse</strong>.
            This ensures stock goes where customers actually buy from — not distributed evenly.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 14, marginBottom: 22 }}>
            <div>
              <div style={{ color: T.dim, fontSize: 9, letterSpacing: 2, marginBottom: 5 }}>SELECT SKU</div>
              <select value={distAsin} onChange={e => setDistAsin(e.target.value)}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 6, background: T.card,
                  border: `1px solid ${T.border}`, color: T.text, fontSize: 12 }}>
                <option value="">— Choose a SKU —</option>
                {inv.map(r => (
                  <option key={r.asin} value={r.asin}>{r.sku} ({r.asin})</option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ color: T.dim, fontSize: 9, letterSpacing: 2, marginBottom: 5 }}>UNITS TO SEND</div>
              <input type="number" value={distQty} onChange={e => setDistQty(+e.target.value)}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 6, boxSizing: "border-box",
                  background: T.card, border: `1px solid ${T.border}`, color: T.bright,
                  fontFamily: "'Space Mono',monospace", fontSize: 18, fontWeight: 700 }} />
            </div>
          </div>

          {distItem ? (
            <>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: "12px 18px", marginBottom: 18, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
                {[
                  { l: "SKU",          v: distItem.sku,          c: T.accent  },
                  { l: "DAILY SALES",  v: distItem.dailySales + "/d", c: T.bright },
                  { l: "FBA DAYS",     v: distItem.fbaDOI >= 9999 ? "∞" : distItem.fbaDOI + "d", c: S[distItem.fbaStatus].color },
                  { l: "FC SELLABLE",  v: distItem.fcSellable,   c: T.purple  },
                  { l: "SUGGESTED SEND",v: distItem.sendQty || "—", c: T.teal },
                ].map(m => (
                  <div key={m.l}>
                    <div style={{ color: T.dim, fontSize: 8, letterSpacing: 1 }}>{m.l}</div>
                    <div style={{ color: m.c, fontFamily: "'Space Mono',monospace", fontSize: 13, fontWeight: 600 }}>{m.v}</div>
                  </div>
                ))}
                <Pill status={distItem.fbaStatus} />
              </div>

              {distAlloc.length > 0 ? (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ color: T.dim, fontSize: 9, letterSpacing: 3, marginBottom: 10 }}>DEMAND % BY AMAZON FC (where customers actually buy from)</div>
                    <div style={{ height: 160 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={distAlloc} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                          <XAxis type="number" tick={{ fill: T.dim, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(0) + "%"} />
                          <YAxis dataKey="fc" type="category" tick={{ fill: T.accent, fontSize: 12, fontFamily: "'Space Mono',monospace" }} axisLine={false} tickLine={false} width={55} />
                          <Tooltip formatter={(v, n) => [n === "pct" ? v.toFixed(1) + "%" : v, n === "pct" ? "Demand %" : "Units"]}
                            contentStyle={{ background: T.card, border: `1px solid ${T.border}`, fontSize: 11 }} />
                          <Bar dataKey="pct" name="pct" fill={T.teal} radius={[0, 3, 3, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: T.surf }}>
                        {["Amazon FC","Historical Sales","Demand %","Units to Send","Bar"].map(h => <TH key={h} ch={h} />)}
                      </tr>
                    </thead>
                    <tbody>
                      {distAlloc.map(fc => (
                        <tr key={fc.fc} style={{ borderBottom: `1px solid ${T.border}15` }}>
                          <TD><span style={{ fontFamily: "'Space Mono',monospace", fontSize: 15, fontWeight: 700, color: T.accent }}>{fc.fc}</span></TD>
                          <TD><Mono v={fc.sales} /></TD>
                          <TD><Mono v={fc.pct} dec={1} suf="%" /></TD>
                          <TD>
                            <span style={{ background: T.teal, color: "#000", padding: "3px 12px", borderRadius: 3,
                              fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14 }}>
                              {fc.allocated}
                            </span>
                          </TD>
                          <TD style={{ width: 200 }}>
                            <div style={{ background: T.border, borderRadius: 3, height: 8 }}>
                              <div style={{ width: `${Math.min(fc.pct, 100)}%`, height: "100%",
                                background: `linear-gradient(90deg, ${T.teal}, ${T.blue})`, borderRadius: 3, transition: "width .4s" }} />
                            </div>
                          </TD>
                        </tr>
                      ))}
                      <tr style={{ borderTop: `1px solid ${T.border}` }}>
                        <TD><span style={{ color: T.dim, fontSize: 9, letterSpacing: 1 }}>TOTAL</span></TD>
                        <TD><Mono v={distItem.totalFCSales} /></TD>
                        <TD><Mono v={100} suf="%" /></TD>
                        <TD>
                          <span style={{ background: T.accent, color: "#000", padding: "3px 12px", borderRadius: 3,
                            fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14 }}>
                            {distAlloc.reduce((a, r) => a + r.allocated, 0)}
                          </span>
                        </TD>
                        <TD />
                      </tr>
                    </tbody>
                  </table>
                </>
              ) : (
                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 30,
                  textAlign: "center", color: T.dim }}>
                  No FC distribution data for this SKU — upload Inventory Ledger with Location column
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "60px 0", color: T.dim }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>◈</div>
              Select a SKU above to see demand-based warehouse distribution
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage]       = useState("import");
  const [selAsin, setSelAsin] = useState(null);
  const [params, setParams]   = useState({ chinaLeadTime: 75, fbaLeadTime: 14, bufferDays: 15, reorderCycle: 60 });
  const [fileStatus, setFileStatus] = useState({ fba: null, ledger: null, shipments: null });
  const [raw, setRaw] = useState({ fba: [], ledger: [], shipments: [] });
  const [fcSell,   setFcSell]   = useState({});
  const [fcUnsell, setFcUnsell] = useState({});
  const [fcAutoStatus, setFcAutoStatus] = useState("idle");
  const [parseCount, setParseCount] = useState({ fba: 0, ledger: 0, shipments: 0 });
  const [parseErr,   setParseErr]   = useState({ fba: "", ledger: "", shipments: "" });

  // Auto-fetch FC sheet on mount
  useEffect(() => {
    async function fetchFC() {
      setFcAutoStatus("loading");
      try {
        const base = `https://docs.google.com/spreadsheets/d/${FC_SHEET_ID}/export?format=csv&sheet=`;
        const [r1, r2] = await Promise.all([
          fetch(base + encodeURIComponent("Sellable_Inventory")),
          fetch(base + encodeURIComponent("Unsellable")),
        ]);
        if (!r1.ok || !r2.ok) throw new Error("Sheet fetch failed");
        const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
        setFcSell(parseSellableFC(t1));
        setFcUnsell(parseUnsellableFC(t2));
        setFcAutoStatus("loaded");
      } catch {
        setFcAutoStatus("error");
      }
    }
    fetchFC();
  }, []);

  function setParam(k, v) { setParams(p => ({ ...p, [k]: v })); }

  function handleFile(type, file) {
    setFileStatus(s => ({ ...s, [type]: "loading" }));
    file.text().then(text => {
      try {
        let data;
        if (type === "fba")            data = parseFBA(text);
        else if (type === "ledger")    data = parseLedger(text);
        else if (type === "shipments") data = parseShipments(text);
        if (!data || data.length === 0) throw new Error("0 rows parsed — check file format");
        setRaw(r => ({ ...r, [type]: data }));
        setFileStatus(s => ({ ...s, [type]: "loaded" }));
        setParseCount(c => ({ ...c, [type]: data.length }));
      } catch (e) {
        setFileStatus(s => ({ ...s, [type]: "error" }));
        setParseErr(c => ({ ...c, [type]: e.message }));
      }
    });
  }

  function handleGS(type, text) {
    try {
      let data;
      if (type === "fba")            data = parseFBA(text);
      else if (type === "ledger")    data = parseLedger(text);
      else if (type === "shipments") data = parseShipments(text);
      if (!data || data.length === 0) throw new Error("0 rows parsed — check sheet name, tab name, and that the sheet is public");
      setRaw(r => ({ ...r, [type]: data }));
      setFileStatus(s => ({ ...s, [type]: "loaded" }));
      setParseCount(c => ({ ...c, [type]: data.length }));
    } catch (e) {
      setFileStatus(s => ({ ...s, [type]: "error" }));
      setParseErr(c => ({ ...c, [type]: e.message }));
    }
  }

  const hasData = raw.fba.length > 0;

  const inventory = useMemo(() =>
    hasData ? buildInventory(raw.fba, raw.ledger, raw.shipments, fcSell, fcUnsell, params) : []
  , [raw, fcSell, fcUnsell, params]);

  const selItem = useMemo(() => inventory.find(r => r.asin === selAsin), [inventory, selAsin]);

  const navItems = [
    { id: "import",   label: "⬆  Import" },
    { id: "dashboard",label: "⊞  Dashboard",    disabled: !hasData },
    { id: "purchase", label: "🛒  Purchase Order",disabled: !hasData },
    { id: "fba",      label: "📦  Send to FBA",   disabled: !hasData },
  ];

  // Status bar counts
  const urgent  = inventory.filter(r => r.fbaStatus === "URGENT").length;
  const reorder = inventory.filter(r => r.fbaStatus === "REORDER").length;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:${T.bg};}
        ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}
        input:focus,select:focus{outline:none;border-color:${T.accent}!important;}
        input[type=range]{height:3px;}
        select option{background:${T.surf};}
        th{user-select:none;}
      `}</style>

      {/* ── Top Nav ── */}
      <div style={{ background: T.surf, borderBottom: `1px solid ${T.border}`, height: 50,
        display: "flex", alignItems: "center", paddingLeft: 20 }}>
        <div style={{ color: T.accent, fontFamily: "'Space Mono',monospace", fontWeight: 700,
          fontSize: 12, letterSpacing: 3, marginRight: 32, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>◈</span> HELETT SCM
        </div>
        {navItems.map(n => (
          <button key={n.id} onClick={() => !n.disabled && setPage(n.id)} style={{
            height: 50, padding: "0 16px", border: "none", cursor: n.disabled ? "default" : "pointer",
            background: page === n.id ? T.accent + "15" : "transparent",
            color: n.disabled ? T.dim + "50" : page === n.id ? T.accent : T.dim,
            borderBottom: `2px solid ${page === n.id ? T.accent : "transparent"}`,
            fontSize: 11, fontWeight: 600, letterSpacing: "0.5px", transition: "all .15s",
          }}>{n.label}</button>
        ))}
        {hasData && (
          <div style={{ marginLeft: "auto", marginRight: 18, display: "flex", gap: 12, alignItems: "center" }}>
            {urgent  > 0 && <span style={{ color: T.red,    fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: 1 }}>{urgent} URGENT</span>}
            {reorder > 0 && <span style={{ color: T.yellow, fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: 1 }}>{reorder} REORDER</span>}
            <span style={{ color: T.dim, fontSize: 10 }}>·</span>
            <span style={{ color: T.green, fontSize: 9 }}>●</span>
            <span style={{ color: T.dim, fontSize: 10 }}>{inventory.length} SKUs</span>
            <span style={{ color: fcAutoStatus === "loaded" ? T.green : T.yellow, fontSize: 9, marginLeft: 4 }}>
              {fcAutoStatus === "loaded" ? "FC ✓" : "FC ⟳"}
            </span>
          </div>
        )}
      </div>

      {/* ── Param Sliders ── */}
      {hasData && (
        <div style={{ background: T.surf, borderBottom: `1px solid ${T.border}`,
          padding: "9px 24px", display: "flex", gap: 20, alignItems: "center" }}>
          <span style={{ color: T.dim, fontSize: 9, letterSpacing: 2, flexShrink: 0 }}>PARAMS:</span>
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
            <Slider label="China Lead Time" value={params.chinaLeadTime} min={30} max={120} onChange={v => setParam("chinaLeadTime", v)} />
            <Slider label="FC→FBA Lead Time" value={params.fbaLeadTime}  min={3}  max={30}  onChange={v => setParam("fbaLeadTime", v)}   />
            <Slider label="Buffer Days"      value={params.bufferDays}   min={0}  max={60}  onChange={v => setParam("bufferDays", v)}     />
            <Slider label="Reorder Cycle"    value={params.reorderCycle} min={30} max={120} onChange={v => setParam("reorderCycle", v)}   />
          </div>
        </div>
      )}

      {/* ── Page Content ── */}
      <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
        {page === "import" && (
          <ImportPage fileStatus={fileStatus} onFile={handleFile} onGS={handleGS}
            onLaunch={() => setPage("dashboard")} hasData={hasData} fcAutoStatus={fcAutoStatus}
            parseCount={parseCount} parseErr={parseErr} raw={raw} />
        )}
        {page === "dashboard" && hasData && (
          <DashboardPage inv={inventory} params={params} onSelect={a => setSelAsin(a)} />
        )}
        {page === "purchase" && hasData && (
          <PurchasePage inv={inventory} params={params} />
        )}
        {page === "fba" && hasData && (
          <FBAPage inv={inventory} params={params} />
        )}
      </div>

      {/* ── SKU Modal ── */}
      {selItem && (
        <SKUModal item={selItem} params={params} onClose={() => setSelAsin(null)} />
      )}
    </div>
  );
}