/**
 * Generates src/api/registry/moduleOwnership.generated.ts from swagger.json.
 *
 * This emits ownership data only — a path -> {module, team} map used by the bug ledger to
 * route each ticket to the right team. It generates no tests: every test in this suite is
 * hand-written under tests/<tag>/.
 *
 * The map is derived from the spec rather than guessed from URL prefixes because KPOST's
 * routes do not follow their tag names (Company Administration lives under `/admin`, Kdiary
 * under `/dairySchedule`), so prefix matching silently mis-routes defects.
 *
 *   node scripts/generate/generateModuleOwnership.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
const swagger = JSON.parse(fs.readFileSync(path.join(ROOT, 'swagger.json'), 'utf-8'));

/** Tags whose own name declares them dead; excluded from the active surface. */
const LEGACY_TAG = /superseded|abandoned/i;

/** Owning team per Swagger tag. A wrong entry here routes a defect to the wrong team. */
const TEAM_BY_TAG = {
  'Authentication V2': 'Identity & Access',
  'Authentication - Medium & Large Enterprise': 'Identity & Access',
  'User Profile V2': 'User Profile',
  'Common Reference Data & Utilities V2': 'Platform Common Services',
  'General Settings': 'Platform Common Services',
  'Katchup Messaging V2': 'Messaging',
  'Kall (Voice/Video) V2 - current': 'Realtime Communications',
  'Contacts Directory V2': 'Contacts',
  'Groups V2': 'Groups',
  'Kdiary - Schedules, Events & Reports': 'Kdiary',
  'Dashboard V2': 'Dashboard',
  Knews: 'Knews',
  'Company Administration': 'Company Administration',
  'KWord Documents': 'Documents',
  KPresentation: 'Documents',
  'Crypto - Payload Encryption Key': 'Platform Security',
  'Integration - RazorPay Payments': 'Payments Integration',
  'TA Wallet Payments': 'Payments Integration',
  'Integration - TA Wallet Callback': 'Payments Integration',
  'Integration - RedBus Bus Booking': 'Travel Integration',
  'Integration - AWS S3 Pre-signed URLs': 'Platform Infrastructure',
  'Firebase Diagnostics': 'Platform Infrastructure',
  'kpost-webservice-application': 'Platform Infrastructure',
  'Integration - AI Assistant': 'AI Integration',
  'Integration - MetaDee AI': 'AI Integration',
  'Integration - Voice / Speech-to-Text': 'AI Integration',
  'Integration - E-commerce Catalogue': 'Commerce Integration',
};

const moduleByPath = {};
const tagCounts = {};

for (const [routePath, item] of Object.entries(swagger.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

    const tag = (op.tags ?? ['Untagged'])[0];
    if (LEGACY_TAG.test(tag)) continue;

    moduleByPath[routePath] = { module: tag, team: TEAM_BY_TAG[tag] ?? 'Platform' };
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }
}

const contents = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generate/generateModuleOwnership.js
 *
 * Ownership data only: maps an endpoint path to its owning Swagger tag and the team a
 * defect should be routed to. Contains no test logic — every test is hand-written under
 * tests/<tag>/.
 *
 * Covers ${Object.keys(moduleByPath).length} active endpoints across ${Object.keys(tagCounts).length} tags.
 */

export interface ModuleOwnership {
  module: string;
  team: string;
}

export const MODULE_BY_PATH: Record<string, ModuleOwnership> = ${JSON.stringify(
  moduleByPath,
  null,
  2
)};
`;

const outDir = path.join(ROOT, 'src', 'api', 'registry');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'moduleOwnership.generated.ts'), contents, 'utf-8');

console.log(
  `Wrote ownership for ${Object.keys(moduleByPath).length} endpoints across ${Object.keys(tagCounts).length} tags.`
);
