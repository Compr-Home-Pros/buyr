import { NextResponse } from "next/server";
import { pushProspects } from "@/lib/clozr";
import { prospectsFromComments, prospectsFromPaste, type CommentInput } from "@/lib/fb-comments";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const comments = Array.isArray((body as { comments?: CommentInput[] }).comments)
    ? (body as { comments: CommentInput[] }).comments
    : [];
  const pasted = typeof (body as { text?: string }).text === "string" ? (body as { text: string }).text : "";
  const found = [...prospectsFromComments(comments), ...prospectsFromPaste(pasted)];
  const unique = [...new Map(found.map((p) => [p.email, p])).values()];
  if (!unique.length) return NextResponse.json({ ok: true, found: 0, sent: 0, prospects: [] });

  const pushed = await pushProspects(unique.map((p) => ({
    name: p.name,
    email: p.email,
    sourceId: `fb:${p.email}:${p.groupName || "group"}`,
    notes: [p.comment, p.groupName && `FB group: ${p.groupName}`, p.dealAddress && `Deal: ${p.dealAddress}`, p.postUrl].filter(Boolean).join(" · "),
    tags: ["buyer-prospect", "fb-comment", "buyr"],
    markets: p.groupName ? [p.groupName] : [],
  })));
  return NextResponse.json({ ok: true, found: unique.length, sent: pushed.sent, error: pushed.error, prospects: unique });
}
