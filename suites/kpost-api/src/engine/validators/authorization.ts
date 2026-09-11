import { assertNoForeignAcknowledgement } from '../../utils/apiAssertions';
import { FOREIGN } from '../../api/clients/generic.client';
import type { Role, Validator } from '../types';

/**
 * Role → decision matrix.
 *
 * ALLOW rows are asserted too, not just denials: a matrix that only checks refusals passes
 * completely when an endpoint refuses everyone — which `getActiveSession` actually does (409 to
 * every caller).
 *
 * Cross-user/tenant denials are judged on ACKNOWLEDGEMENT, not status. A correct implementation
 * may answer 200 having ignored a foreign id, which is safe; what is never safe is that id coming
 * back in the response.
 */

/** Roles whose denial is about identity scoping rather than a role check. */
const OWNERSHIP_ROLES: ReadonlySet<Role> = new Set(['USER', 'COMPANY_ADMIN']);

export const authorizationValidator: Validator = {
  stage: 'authorization',

  appliesTo: (endpoint) => Object.keys(endpoint.authorization ?? {}).length > 0,

  async run({ endpoint, request, roleTokens }) {
    const matrix = endpoint.authorization ?? {};
    const failures: string[] = [];
    const unavailable: string[] = [];

    const body = endpoint.buildRequest?.();
    const meta = {
      method: endpoint.method,
      path: endpoint.path,
      repro: `apiEngine.run(${endpoint.id}) — authorization stage`,
      body,
    };

    for (const [role, decision] of Object.entries(matrix) as Array<[Role, 'ALLOW' | 'DENY']>) {
      /*
       * UNAUTHENTICATED is covered exhaustively by the authentication stage, which runs eight
       * credential shapes rather than one. Repeating it here would file the same fault twice.
       */
      if (role === 'UNAUTHENTICATED') continue;

      const token = roleTokens?.[role];
      if (!token) {
        /*
         * A missing role token is stated, never silently skipped. An authorization matrix that
         * quietly does not run is worse than no matrix: the report shows a covered endpoint.
         */
        unavailable.push(`${role} (no token available for this role)`);
        continue;
      }

      const response = await request.fetch(endpoint.path, {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body !== undefined && !['GET', 'HEAD', 'DELETE'].includes(endpoint.method)
          ? { data: body }
          : {}),
        failOnStatusCode: false,
      });
      const status = response.status();

      if (status === 429) continue; // throttled: says nothing about authorization

      if (decision === 'ALLOW') {
        if (!endpoint.expectedStatuses.includes(status)) {
          failures.push(
            `${role} is granted ALLOW but received HTTP ${status}, which is not among this endpoint's expected statuses (${endpoint.expectedStatuses.join('/')})`
          );
        }
        continue;
      }

      /* DENY. Ownership roles are judged on acknowledgement; true role denials on status. */
      if (OWNERSHIP_ROLES.has(role)) {
        await assertNoForeignAcknowledgement(response, {
          ...meta,
          what: 'kpostID',
          foreignValue: FOREIGN.victimKpostID,
        });
        continue;
      }

      if (status !== 401 && status !== 403) {
        failures.push(`${role} is denied by the matrix but received HTTP ${status} (expected 401/403)`);
      }
    }

    if (failures.length) return { outcome: 'failed', detail: failures.join('; ') };
    if (unavailable.length) {
      return {
        outcome: 'skipped',
        detail: `matrix partially unexercised — ${unavailable.join(', ')}`,
      };
    }
    return { outcome: 'passed' };
  },
};
