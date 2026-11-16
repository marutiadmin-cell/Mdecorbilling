/**
 * The job card as the workshop knows it — the shop's own layout:
 *
 *   M Décor Order Detail
 *   Job Number: WB-0136                     (red)
 *   Date / Customer Name / Address / Mobile Number (green)
 *   ───────────────────────────────
 *   Serial Number | 1221
 *   Type          | Easy Lift (Single Dori / Chain System)
 *   Operate Side  | Right
 *   Size (W*H)    | W57.25  H139
 *   Note          | 31-10-2026 sanj sudhima ready kari apva
 *
 * Optionally followed by "For the workshop": the materials this size takes
 * and, for slats/rails kept by length, the pieces to cut.
 */
import type { Company, JobCard } from "@/types";
import { cardSize } from "@/lib/jobCards";

export interface WorkshopLine {
  name: string;
  qty: string;
}

export function JobCardPrint({
  card,
  company,
  workshop,
}: {
  card: JobCard;
  company: Pick<Company, "name">;
  workshop?: { materials: WorkshopLine[]; cuts: WorkshopLine[] } | null;
}) {
  const when = new Date(card.createdAt || card.date);
  const dateText = isNaN(when.getTime())
    ? card.date
    : when.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  const n = (x: number) => String(Math.round((Number(x) || 0) * 100) / 100);
  const u = card.size.unit === "in" ? "" : ` ${card.size.unit}`;
  const row = (label: string, value: React.ReactNode) => (
    <tr>
      <td
        style={{
          border: "1.5px solid #222",
          padding: "14px 18px",
          width: "38%",
          verticalAlign: "top",
        }}
      >
        {label}
      </td>
      <td
        style={{
          border: "1.5px solid #222",
          padding: "14px 18px",
          verticalAlign: "top",
          whiteSpace: "pre-line",
        }}
      >
        {value}
      </td>
    </tr>
  );
  return (
    <div
      style={{
        fontFamily: "Nunito, system-ui, sans-serif",
        color: "#111",
        padding: "18px 14px",
        background: "#fff",
      }}
      data-job-card={card.number}
    >
      <h1 style={{ color: "#141a7a", fontSize: 30, fontWeight: 800, margin: "0 0 8px" }}>
        {company.name} Order Detail
      </h1>
      <h2 style={{ color: "#e5483b", fontSize: 26, fontWeight: 800, margin: "0 0 12px" }}>
        Job Number: {card.number}
      </h2>
      <div style={{ fontSize: 15, lineHeight: 1.75 }}>
        <div>
          <b>Date</b>: {dateText}
        </div>
        <div>
          <b>Customer Name</b>: {card.partyName}
        </div>
        <div>
          <b>Address</b>: {card.partyAddress ?? ""}
        </div>
        <div>
          <b>Mobile Number</b>: <b style={{ color: "#2eaa3c" }}>{card.partyPhone ?? ""}</b>
        </div>
        {card.dueDate && (
          <div>
            <b>Ready by</b>: {card.dueDate}
          </div>
        )}
      </div>
      <hr style={{ border: 0, borderTop: "1.5px solid #999", margin: "14px 0 18px" }} />
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 15 }}>
        <tbody>
          {row("Serial Number", card.serial ?? "")}
          {row("Type", card.type ?? "")}
          {row("Operate Side", card.operateSide ?? "")}
          {row(
            "Size (W*H)",
            `W${n(card.size.w)}${u}\nH${n(card.size.h)}${u}${card.pieces > 1 ? `\n× ${card.pieces} pcs` : ""}`,
          )}
          {row("Note", card.note ?? "")}
        </tbody>
      </table>
      {workshop && (workshop.materials.length > 0 || workshop.cuts.length > 0) && (
        <div style={{ marginTop: 18, fontSize: 13 }}>
          <b style={{ fontSize: 14 }}>
            For the workshop — {card.finishedItemName}, {cardSize(card)}
          </b>
          {workshop.cuts.length > 0 && (
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}>
              <tbody>
                {workshop.cuts.map((c, i) => (
                  <tr key={i}>
                    <td style={{ border: "1px solid #999", padding: "5px 8px" }}>✂ {c.name}</td>
                    <td style={{ border: "1px solid #999", padding: "5px 8px" }}>{c.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}>
            <tbody>
              {workshop.materials.map((m, i) => (
                <tr key={i}>
                  <td style={{ border: "1px solid #999", padding: "5px 8px" }}>{m.name}</td>
                  <td style={{ border: "1px solid #999", padding: "5px 8px", textAlign: "right" }}>
                    {m.qty}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
