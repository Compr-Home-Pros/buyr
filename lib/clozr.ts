// Server-side CLOZR calls. The ingest key never reaches the browser.

export type ProspectPush = {
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  sourceId: string;
  tags?: string[];
  markets?: string[];
};

export function ingestUrl(): string {
  return (process.env.CLOZR_INGEST_URL || "").trim();
}

export function ingestKey(): string {
  return (process.env.CLOZR_INGEST_KEY || "").trim();
}

export function buyrQueueUrl(): string {
  const explicit = (process.env.CLOZR_BUYR_URL || "").trim();
  if (explicit) return explicit;
  const ingest = ingestUrl();
  return ingest.endsWith("/ingest") ? ingest.slice(0, -"/ingest".length) + "/buyr" : "";
}

export async function pushProspects(rows: ProspectPush[]): Promise<{ sent: number; error?: string }> {
  const url = ingestUrl();
  const key = ingestKey();
  if (!url || !key) return { sent: 0, error: "CLOZR ingest is not configured" };
  let sent = 0;
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.name && !row.email && !row.phone) continue;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        source: "buyr",
        source_id: row.sourceId.slice(0, 240),
        type: "buyer.captured",
        buyer: {
          name: row.name || row.email || row.phone,
          email: row.email || undefined,
          phone: row.phone || undefined,
          notes: row.notes || undefined,
          markets: row.markets?.length ? row.markets : undefined,
          tags: row.tags?.length ? row.tags : ["buyer-prospect", "buyr"],
        },
      }),
    });
    if (!res.ok) {
      errors.push(await res.text());
      continue;
    }
    sent += 1;
  }
  return errors.length ? { sent, error: errors[0].slice(0, 200) } : { sent };
}

export async function fetchSnipeQueue(days = 90): Promise<{ ok: boolean; deals: { id: number; address: string; created_at: string }[]; wholesaler_optins: { domain: string; url: string | null }[]; error?: string; aged_days?: number }> {
  const url = buyrQueueUrl();
  const key = ingestKey();
  if (!url || !key) return { ok: false, deals: [], wholesaler_optins: [], error: "CLOZR buyr queue is not configured" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ action: "queue", days }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, deals: [], wholesaler_optins: [], error: data.error || `HTTP ${res.status}` };
  return data;
}
