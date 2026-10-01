import "jsr:@supabase/functions-js@2.4.4/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const REPORT_TO_EMAIL = Deno.env.get("REPORT_TO_EMAIL") || "mathias2000269@gmail.com";
const TIME_ZONE = "Europe/Madrid";
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;

type RevenueEntry = {
  id: number;
  order_id: string;
  customer_name: string;
  phone: string | null;
  notes: string;
  items: Array<{ name?: string; quantity?: number; unit_price?: number }> | null;
  amount: number | string;
  completed_at: string;
};

type ExpenseEntry = {
  id: number;
  expense_id: string;
  amount: number | string;
  concept: string;
  created_by_name: string;
  spent_at: string;
  cancelled_at: string | null;
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

function madridParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year:value("year"), month:value("month"), day:value("day"), hour:value("hour"), minute:value("minute") };
}

// Convierte las 00:00 de una fecha de Madrid a UTC, incluyendo automáticamente
// el horario de verano o invierno vigente en ese mes.
function madridMonthStartUtc(year: number, monthIndex: number) {
  const desired = Date.UTC(year, monthIndex, 1, 0, 0, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = madridParts(new Date(guess));
    const representedAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0);
    guess += desired - representedAsUtc;
  }
  return new Date(guess);
}

function reportPeriod(now = new Date()) {
  const local = madridParts(now);
  const periodEnd = madridMonthStartUtc(local.year, local.month - 1);
  const periodStart = madridMonthStartUtc(local.month === 1 ? local.year - 1 : local.year, local.month === 1 ? 11 : local.month - 2);
  return { local, periodStart, periodEnd };
}

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: TIME_ZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMonth(value: Date) {
  const label = new Intl.DateTimeFormat("es-ES", {
    timeZone: TIME_ZONE,
    month: "long",
    year: "numeric",
  }).format(value);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function money(value: number) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function pdfText(value: unknown) {
  return String(value ?? "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function getSupabaseSecretKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}

async function createReportPdf(
  revenues: RevenueEntry[],
  expenses: ExpenseEntry[],
  periodStart: Date,
  periodEnd: Date,
) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const gold = rgb(0.77, 0.56, 0.17);
  const dark = rgb(0.08, 0.08, 0.08);
  const muted = rgb(0.38, 0.38, 0.38);
  const paper = rgb(0.96, 0.95, 0.92);
  let page!: PDFPage;
  let y = 0;

  const addPage = () => {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawRectangle({ x:0, y:0, width:PAGE_WIDTH, height:PAGE_HEIGHT, color:rgb(1, 1, 1) });
    page.drawRectangle({ x:0, y:PAGE_HEIGHT - 18, width:PAGE_WIDTH, height:18, color:gold });
    page.drawText("K.I.D.  |  KEEP IT DIGGING", { x:MARGIN, y:PAGE_HEIGHT - 48, size:10, font:bold, color:dark });
    y = PAGE_HEIGHT - 72;
  };

  const ensure = (height: number) => {
    if (y - height < 45) addPage();
  };

  const sectionTitle = (title: string, count: number) => {
    ensure(48);
    page.drawText(pdfText(title), { x:MARGIN, y, size:17, font:bold, color:dark });
    page.drawText(`${count} movimiento${count === 1 ? "" : "s"}`, { x:PAGE_WIDTH - MARGIN - 105, y:y + 2, size:9, font:regular, color:muted });
    y -= 27;
  };

  const gross = revenues.reduce((sum, item) => sum + Number(item.amount), 0);
  const totalExpenses = expenses.filter((item) => !item.cancelled_at).reduce((sum, item) => sum + Number(item.amount), 0);

  addPage();
  page.drawText("CIERRE FINANCIERO MENSUAL", { x:MARGIN, y, size:23, font:bold, color:dark });
  y -= 27;
  page.drawText(pdfText(formatMonth(periodStart)), { x:MARGIN, y, size:14, font:regular, color:gold });
  y -= 20;
  page.drawText(`Periodo: ${formatDate(periodStart)} - ${formatDate(new Date(periodEnd.getTime() - 1))}`, { x:MARGIN, y, size:9, font:regular, color:muted });
  y -= 38;

  const summaries = [
    ["INGRESOS BRUTOS", money(gross)],
    ["GASTOS", money(totalExpenses)],
    ["INGRESOS NETOS", money(gross - totalExpenses)],
  ];
  summaries.forEach(([label, value], index) => {
    const width = 160;
    const x = MARGIN + index * 170;
    page.drawRectangle({ x, y:y - 58, width, height:66, color:paper, borderColor:gold, borderWidth:1 });
    page.drawText(label, { x:x + 10, y:y - 13, size:7.5, font:bold, color:muted });
    page.drawText(pdfText(value), { x:x + 10, y:y - 39, size:13, font:bold, color:dark });
  });
  y -= 94;

  sectionTitle("PEDIDOS COMPLETADOS", revenues.length);
  if (!revenues.length) {
    page.drawText("No hubo pedidos completados en este cierre.", { x:MARGIN, y, size:10, font:regular, color:muted });
    y -= 30;
  }
  for (const entry of revenues) {
    const items = Array.isArray(entry.items) && entry.items.length
      ? entry.items.map((item) => `${Number(item.quantity || 0)}x ${item.name || "Material"}`).join(", ")
      : "Detalle de materiales no disponible";
    const itemLines = wrap(items, regular, 9, PAGE_WIDTH - MARGIN * 2 - 22);
    const shortenedNotes = entry.notes?.length > 500 ? `${entry.notes.slice(0, 500)}...` : entry.notes;
    const noteLines = shortenedNotes ? wrap(`Notas: ${shortenedNotes}`, regular, 8, PAGE_WIDTH - MARGIN * 2 - 22) : [];
    const height = 70 + itemLines.length * 11 + noteLines.length * 10;
    ensure(height + 10);
    page.drawRectangle({ x:MARGIN, y:y - height, width:PAGE_WIDTH - MARGIN * 2, height, color:paper });
    page.drawRectangle({ x:MARGIN, y:y - height, width:4, height, color:gold });
    page.drawText(pdfText(`${entry.customer_name}  |  Pedido ${entry.order_id.slice(0, 8).toUpperCase()}`), { x:MARGIN + 12, y:y - 18, size:10, font:bold, color:dark });
    page.drawText(pdfText(money(Number(entry.amount))), { x:PAGE_WIDTH - MARGIN - 95, y:y - 18, size:10, font:bold, color:dark });
    page.drawText(pdfText(`${formatDate(entry.completed_at)}${entry.phone ? `  |  Tel. ${entry.phone}` : ""}`), { x:MARGIN + 12, y:y - 34, size:8, font:regular, color:muted });
    let lineY = y - 51;
    for (const line of itemLines) { page.drawText(line, { x:MARGIN + 12, y:lineY, size:9, font:regular, color:dark }); lineY -= 11; }
    for (const line of noteLines) { page.drawText(line, { x:MARGIN + 12, y:lineY, size:8, font:regular, color:muted }); lineY -= 10; }
    y -= height + 9;
  }

  y -= 12;
  sectionTitle("GASTOS", expenses.length);
  if (!expenses.length) {
    page.drawText("No hubo gastos en este cierre.", { x:MARGIN, y, size:10, font:regular, color:muted });
    y -= 30;
  }
  for (const entry of expenses) {
    const conceptLines = wrap(entry.concept, regular, 9, PAGE_WIDTH - MARGIN * 2 - 125);
    const height = 52 + conceptLines.length * 11;
    ensure(height + 10);
    page.drawRectangle({ x:MARGIN, y:y - height, width:PAGE_WIDTH - MARGIN * 2, height, color:paper });
    page.drawRectangle({ x:MARGIN, y:y - height, width:4, height, color:entry.cancelled_at ? muted : gold });
    page.drawText(pdfText(entry.created_by_name), { x:MARGIN + 12, y:y - 17, size:10, font:bold, color:dark });
    page.drawText(pdfText(`${entry.cancelled_at ? "CANCELADO  |  " : ""}-${money(Number(entry.amount))}`), { x:PAGE_WIDTH - MARGIN - 115, y:y - 17, size:9, font:bold, color:entry.cancelled_at ? muted : dark });
    page.drawText(pdfText(formatDate(entry.spent_at)), { x:MARGIN + 12, y:y - 32, size:8, font:regular, color:muted });
    let lineY = y - 48;
    for (const line of conceptLines) { page.drawText(line, { x:MARGIN + 12, y:lineY, size:9, font:regular, color:dark }); lineY -= 11; }
    y -= height + 9;
  }

  const pages = document.getPages();
  pages.forEach((reportPage, index) => {
    reportPage.drawText(`Documento generado automáticamente · Página ${index + 1} de ${pages.length}`, {
      x:MARGIN,
      y:22,
      size:7.5,
      font:regular,
      color:muted,
    });
  });
  return document.save();
}

async function loadAllBefore<T>(client: ReturnType<typeof createClient>, table: string, dateColumn: string, cutoff: string) {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .lt(dateColumn, cutoff)
      .order(dateColumn, { ascending:true })
      .order("id", { ascending:true })
      .range(start, start + pageSize - 1);
    if (error) throw error;
    rows.push(...((data || []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error:"Método no permitido." }, 405);

  const reportSecret = Deno.env.get("MONTHLY_REPORT_SECRET");
  if (!reportSecret || request.headers.get("x-report-secret") !== reportSecret) {
    return json({ error:"Acceso denegado." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseSecretKey();
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("REPORT_FROM_EMAIL");
  if (!supabaseUrl || !serviceKey || !resendKey || !fromEmail) {
    return json({ error:"Faltan secretos de Supabase, Resend o el remitente." }, 500);
  }

  let body: { force?: boolean } = {};
  try { body = await request.json(); } catch { /* El cron siempre envía JSON. */ }

  const { local, periodStart, periodEnd } = reportPeriod();
  if (!body.force && !(local.day === 1 && local.hour === 0)) {
    return json({ skipped:true, reason:"Fuera de la hora mensual de Madrid." });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth:{ autoRefreshToken:false, persistSession:false },
  });
  const cutoff = periodEnd.toISOString();
  let { data: archive, error: archiveReadError } = await admin
    .from("monthly_financial_archives")
    .select("*")
    .eq("period_end", cutoff)
    .maybeSingle();
  if (archiveReadError) return json({ error:archiveReadError.message }, 500);
  if (archive?.status === "completed") return json({ skipped:true, reason:"Este mes ya está archivado." });

  if (!archive) {
    const result = await admin.from("monthly_financial_archives").insert({
      period_start:periodStart.toISOString(),
      period_end:cutoff,
      status:"preparing",
    }).select("*").single();
    if (result.error) {
      const retry = await admin.from("monthly_financial_archives").select("*").eq("period_end", cutoff).single();
      if (retry.error) return json({ error:result.error.message }, 500);
      archive = retry.data;
    } else {
      archive = result.data;
    }
  } else if (archive.status === "failed") {
    await admin.from("monthly_financial_archives").update({ status:"preparing" }).eq("id", archive.id);
  }

  try {
    const [revenues, expenses] = await Promise.all([
      loadAllBefore<RevenueEntry>(admin, "revenue_ledger", "completed_at", cutoff),
      loadAllBefore<ExpenseEntry>(admin, "expense_ledger", "spent_at", cutoff),
    ]);
    const pdf = await createReportPdf(revenues, expenses, periodStart, periodEnd);
    const reportMonth = madridParts(periodStart);
    const fileName = `KID-cierre-${reportMonth.year}-${String(reportMonth.month).padStart(2, "0")}.pdf`;
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method:"POST",
      headers:{
        Authorization:`Bearer ${resendKey}`,
        "Content-Type":"application/json",
        "Idempotency-Key":`kid-monthly-${cutoff.slice(0, 10)}`,
      },
      body:JSON.stringify({
        from:fromEmail,
        to:[REPORT_TO_EMAIL],
        subject:`K.I.D. · Cierre financiero de ${formatMonth(periodStart)}`,
        html:`<h2>Cierre financiero de ${formatMonth(periodStart)}</h2><p>El PDF adjunto contiene la lista de pedidos completados y gastos archivados del periodo.</p>`,
        attachments:[{ filename:fileName, content:bytesToBase64(pdf) }],
      }),
    });
    const emailResult = await emailResponse.json();
    if (!emailResponse.ok) throw new Error(emailResult?.message || "Resend no aceptó el correo.");

    const { data:finalized, error:finalizeError } = await admin.rpc("finalize_monthly_financial_archive", {
      p_archive_id:archive.id,
      p_period_end:cutoff,
      p_email_id:String(emailResult.id || ""),
    });
    if (finalizeError) throw finalizeError;

    return json({ ok:true, archive_id:archive.id, email_id:emailResult.id, result:finalized });
  } catch (error) {
    await admin.from("monthly_financial_archives").update({ status:"failed" }).eq("id", archive.id);
    return json({ error:error instanceof Error ? error.message : "No se pudo completar el cierre mensual." }, 500);
  }
});
