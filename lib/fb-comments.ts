// Pull buyer name + email out of Facebook group comments.
// The Home Pros page is already in these groups; Deal Machine scrolls them.
// This is the same capture, filed as Buyer Prospects instead of the vetted list.

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

/** Addresses that are ours, or that show up in every comment thread. */
const SKIP_EMAIL = new Set([
  "deals@selltohomepros.com",
  "dean@selltohomepros.com",
]);

export type CommentInput = {
  name?: string | null;
  text?: string | null;
  groupName?: string | null;
  groupUrl?: string | null;
  postUrl?: string | null;
  dealAddress?: string | null;
};

export type BuyerProspect = {
  name: string;
  email: string;
  groupName: string;
  groupUrl: string;
  postUrl: string;
  dealAddress: string;
  comment: string;
};

export function prospectsFromComments(comments: CommentInput[]): BuyerProspect[] {
  const seen = new Set<string>();
  const out: BuyerProspect[] = [];
  for (const comment of comments) {
    const text = String(comment.text ?? "");
    const emails = text.match(EMAIL) ?? [];
    for (const raw of emails) {
      const email = raw.toLowerCase();
      if (SKIP_EMAIL.has(email) || seen.has(email)) continue;
      seen.add(email);
      const name = cleanName(comment.name) || nameNear(text, raw) || email;
      out.push({
        name,
        email,
        groupName: String(comment.groupName ?? "").trim(),
        groupUrl: String(comment.groupUrl ?? "").trim(),
        postUrl: String(comment.postUrl ?? "").trim(),
        dealAddress: String(comment.dealAddress ?? "").trim(),
        comment: text.replace(EMAIL, " ").replace(/\s+/g, " ").trim().slice(0, 240),
      });
    }
  }
  return out;
}

/** A pasted thread: "Jane Doe: send it to jane@x.com" or a bare email. */
export function prospectsFromPaste(raw: string): BuyerProspect[] {
  const comments: CommentInput[] = [];
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const named = trimmed.match(/^([^:]{2,80}):\s*(.+)$/);
    if (named && named[2].includes("@")) {
      comments.push({ name: named[1], text: named[2] });
    } else {
      comments.push({ text: trimmed });
    }
  }
  return prospectsFromComments(comments);
}

function cleanName(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim();
}

function nameNear(text: string, email: string): string {
  const idx = text.toLowerCase().indexOf(email.toLowerCase());
  const before = (idx > 0 ? text.slice(Math.max(0, idx - 40), idx) : "").replace(/[^a-zA-Z\s'.-]/g, " ");
  const words = before.trim().split(/\s+/).filter((w) => /^[A-Z][a-zA-Z'.-]{1,}$/.test(w));
  return words.slice(-2).join(" ");
}
