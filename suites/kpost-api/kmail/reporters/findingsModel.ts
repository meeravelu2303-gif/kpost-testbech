import crypto from 'crypto';

/**
 * The run model that both publishers — Bugzilla and the QA Dashboard — consume.
 *
 * The specs record findings as Playwright attachments (see `src/utils/findings.ts`); this
 * module turns that raw stream into a **deduplicated defect ledger**. The same defect surfaces
 * from many tests — an ownership gap on one route is probed by a dozen cases — so a ledger that
 * did not dedupe would file a dozen Bugzilla tickets for one fix. Dedup is by
 * (classification, endpoint, title): identical findings collapse into one defect that counts
 * its occurrences and lists every affected endpoint.
 */

export type Severity = 'Critical' | 'Major' | 'Minor' | 'Low';

/** One finding as recorded by `src/utils/findings.ts` and attached to a test. */
export interface RawFinding {
  title: string;
  severity: Severity;
  classification: string;
  endpoint: string; // "METHOD /path"
  description: string;
  expected: string;
  actual: string;
  riskImpact?: string;
  /** Path-independent identity for a systemic fault; when set it replaces `classification|path|title`. */
  dedupeKey?: string;
  stepsToReproduce?: {
    request?: string;
    headers?: Record<string, string>;
    body?: string | null;
  };
}

/** A deduplicated defect — one real problem, however many tests surfaced it. */
export interface Defect {
  /** Stable short id, derived from the defect's identity. Also the Bugzilla dedup tag. */
  id: string;
  title: string;
  severity: Severity;
  classification: string;
  /** Coarse category for the Bugzilla whiteboard and the dashboard: Security | Functional | Contract. */
  category: 'Security' | 'Functional' | 'Contract';
  /** Bugzilla priority band derived from severity. */
  priority: 'Highest' | 'High' | 'Normal' | 'Low';
  method: string;
  endpointPath: string;
  /** The Bugzilla component this defect is routed to (all default-assign to Jitendra Kumar). */
  module: string;
  description: string;
  expected: string;
  actual: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  reproSnippet?: string;
  /** Every endpoint this defect was seen on. */
  affectedEndpoints: string[];
  /** How many test cases surfaced it. */
  occurrences: number;
}

/**
 * Routes a KMail endpoint path to its Bugzilla component.
 *
 * The component names match the `KMail API` product created in Bugzilla, and **every one of
 * them default-assigns to `jitendra@kpost.in`** — so the routing here only decides which
 * component a ticket lands in, never who it goes to. Even the fallback stays with Jitendra.
 */
export function componentForPath(path: string): string {
  const p = path.toLowerCase();
  if (p.startsWith('/v2/sentmail/') || p.startsWith('/sentmail/')) {
    return 'Sent Mail - Compose & Send';
  }
  if (p.startsWith('/v2/readmail/')) return 'Read Mail & Attachments';
  if (p.startsWith('/v2/draft/')) return 'Draft Mail';
  if (p.startsWith('/v2/kmailsetting/')) return 'KMail Settings - Signature & Letterhead';
  if (p.startsWith('/v2/translator/')) return 'Translation';
  if (p.startsWith('/v2/kmaildata/')) return 'Storage Quota';
  if (p.startsWith('/v2/common/')) {
    // The contacts / sync / unsubscribe endpoints live under /v2/common/ alongside the mailbox
    // ones, but belong to a different concern and component.
    const CONTACTS = [
      'addotherdomaincontacts',
      'editotherdomaincontactsdetails',
      'deleteotherdomaincontact',
      'knownpostboxcontacts',
      'unusedpostboxcontacts',
      'miscellaneouscontacts',
      'frequentkmailcontact',
      'saveunsubscriberdetails',
      'getsaluations',
      'getinstantreply',
      'mailserverconnection',
    ];
    if (CONTACTS.some((c) => p.includes('/v2/common/' + c))) return 'Contacts & Sync';
    return 'Mailbox, Folders & Follow-up';
  }
  return 'kmail-application';
}

const CATEGORY_BY_CLASSIFICATION: Record<string, Defect['category']> = {
  'Authentication Bypass': 'Security',
  'Broken Object-Level Authorisation': 'Security',
  'Cross-Tenant Data Exposure': 'Security',
  'Security/Information Disclosure': 'Security',
  'Security/Injection': 'Security',
  'Security/Reflected Payload': 'Security',
  'Incorrect HTTP Status': 'Functional',
  'Input Validation Gap': 'Functional',
  'Status Misreporting': 'Functional',
  'Unbounded Response': 'Functional',
  'Unhandled Server Error': 'Functional',
  // Functional, not a separate "Contract" band: the Bug Tracker UI (and the KPost bench) only
  // model Functional/Security/Performance/Compatibility, and KPost categorises schema/contract
  // defects as Functional. Emitting 'Contract' here left these bugs Unclassified in the UI.
  'Schema Violation': 'Functional',
};

const PRIORITY_BY_SEVERITY: Record<Severity, Defect['priority']> = {
  Critical: 'Highest',
  Major: 'High',
  Minor: 'Normal',
  Low: 'Low',
};

function splitEndpoint(endpoint: string): { method: string; path: string } {
  const space = endpoint.indexOf(' ');
  if (space === -1) return { method: '', path: endpoint };
  return { method: endpoint.slice(0, space), path: endpoint.slice(space + 1) };
}

/** Stable identity for a finding, so the same problem always gets the same defect id. */
function defectKey(f: RawFinding): string {
  // A systemic fault (e.g. the shared auth filter answering the wrong status on every route)
  // carries a path-independent key, so all its occurrences collapse to one defect. Everything
  // else stays per-endpoint via classification|path|title.
  if (f.dedupeKey) return f.dedupeKey;
  const { path } = splitEndpoint(f.endpoint);
  return `${f.classification}|${path}|${f.title}`;
}

/** `KM-xxxxxx` — deterministic from the defect key, so re-runs reuse the id (and the ticket). */
function defectId(key: string): string {
  return 'KM-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 6).toUpperCase();
}

const SEVERITY_RANK: Record<Severity, number> = { Critical: 0, Major: 1, Minor: 2, Low: 3 };

/** Collapses raw findings into a deduplicated, severity-sorted defect ledger. */
export function buildDefects(findings: RawFinding[]): Defect[] {
  const byKey = new Map<string, Defect>();

  for (const f of findings) {
    const key = defectKey(f);
    const { method, path } = splitEndpoint(f.endpoint);
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.affectedEndpoints.includes(f.endpoint)) {
        existing.affectedEndpoints.push(f.endpoint);
      }
      continue;
    }
    byKey.set(key, {
      id: defectId(key),
      title: f.title,
      severity: f.severity,
      classification: f.classification,
      category: CATEGORY_BY_CLASSIFICATION[f.classification] ?? 'Functional',
      priority: PRIORITY_BY_SEVERITY[f.severity],
      method,
      endpointPath: path,
      module: componentForPath(path),
      description: f.description,
      expected: f.expected,
      actual: f.actual,
      requestHeaders: f.stepsToReproduce?.headers,
      requestBody: f.stepsToReproduce?.body ?? undefined,
      reproSnippet: f.stepsToReproduce?.request,
      affectedEndpoints: [f.endpoint],
      occurrences: 1,
    });
  }

  return [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id)
  );
}

export interface RunSummary {
  generatedAt: string;
  environment: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface BugReport {
  run: RunSummary;
  defects: Defect[];
}
