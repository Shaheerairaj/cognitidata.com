// Outreach review room — types + pure logic (ADR-062 phase 3). No React in here; unit-tested.
// The wire package mirrors backend `metadata.outreach`: the email content + the job's
// generated_at stamp + the edit endpoint's edited_fields/edited_at.

import { CORPORATE_OWNER_TYPES, contactsStatus, ownerStatus } from "./filters";

// Email only — the teaser is one static PDF (ADR-126). Old stored packages may still carry
// slide fields and `direction`; nothing reads them.
export type OutreachContent = {
  email_subject: string;
  email_body: string;
};

export type OutreachRecipient = {
  mode: "owner-direct" | "corporate" | "no-contact";
  name: string | null;
  title: string | null;
};

export type OutreachPackage = {
  identity: Record<string, unknown>;
  recipient?: OutreachRecipient; // ADR-068 — absent on pre-068 packages
  content: OutreachContent;
  generated_at: string;
  edited_fields?: string[];
  edited_at?: string;
};

export type OutreachEditableField = "email_subject" | "email_body"; // call script retired (ADR-069)

// ADR-066: a lead may move to the outreach stage only once owner research AND contact enrichment
// have each run at least once — an attempt that found nothing counts; never-run blocks. Apollo
// contact enrichment only ever runs for corporate owners (institutional/government); for
// non-corporate owners the web contact hunt happens inside the owner run, so a completed owner
// attempt covers the contact requirement.
export type OutreachBlocker = "owner research" | "contact enrichment";
export function outreachBlockers(r: {
  ownerName?: string | null;
  ownerType?: string | null;
  ownerAttemptedAt?: string | null;
  contactsAttemptedAt?: string | null;
  ownerContacts?: { name?: string | null }[] | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerLinkedin?: string | null;
  ownerReachVia?: string | null;
}): OutreachBlocker[] {
  const out: OutreachBlocker[] = [];
  if (ownerStatus({ ownerName: r.ownerName ?? null, ownerAttemptedAt: r.ownerAttemptedAt }) === "pending") {
    out.push("owner research");
  }
  const corporate = CORPORATE_OWNER_TYPES.has((r.ownerType ?? "").toLowerCase());
  const contactsCovered =
    contactsStatus(r as Parameters<typeof contactsStatus>[0]) !== "pending" ||
    (!corporate && Boolean(r.ownerAttemptedAt));
  if (!contactsCovered) out.push("contact enrichment");
  return out;
}

// Review-room addressee line (ADR-068); null for pre-068 packages (caller falls back to ownerName).
export function recipientLabel(pkg: Pick<OutreachPackage, "recipient">): string | null {
  const r = pkg.recipient;
  if (!r) return null;
  if (r.mode === "no-contact") return "→ ownership team";
  return `→ ${r.name} · ${r.mode === "owner-direct" ? "owner" : (r.title ?? "corporate")}`;
}

// Optimistic-update merge for one edit — same semantics as the backend's _merge_outreach_edit
// (content field set; edited_fields deduped-append). edited_at is left to the server response.
export function withEditedField(
  pkg: OutreachPackage,
  field: OutreachEditableField,
  value: string,
): OutreachPackage {
  return {
    ...pkg,
    content: { ...pkg.content, [field]: value },
    edited_fields: [...(pkg.edited_fields ?? []).filter((f) => f !== field), field],
  };
}

// Review-room export selection: the zip includes only ticked leads that actually have a
// generated package, in review-list order.
export function exportTargets<T extends { id: string; outreach?: unknown }>(
  reviewRows: T[],
  tickedIds: string[],
): T[] {
  return reviewRows.filter((r) => tickedIds.includes(r.id) && Boolean(r.outreach));
}
