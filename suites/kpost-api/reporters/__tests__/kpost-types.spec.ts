import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import * as T from '../../src/api/enums/kpostTypes';

/*
 * The enum module must say exactly what the workbook's Types tab says — offline, no backend.
 *
 * `src/api/enums/kpostTypes.ts` gives the codes readable names; `docs/excel/types.json` is the tab
 * itself, re-read by `npm run contract:types`. This checks both directions for every section:
 *
 *   - every constant's number exists in the tab, and the tab's label for it contains every word of
 *     the constant's name (`forwardReveal` → "Forward Message(Reveal)");
 *   - every number the tab lists has a constant — so a new workbook value fails here on arrival
 *     instead of being silently untested.
 *
 * Why it exists: the bench once hand-labelled messageType 18 "Secret / Conf." and filed an invalid
 * Critical on it (BUG-API-6EEBB3). The tab said 18 is Secret the whole time.
 */

type Section = { cell: string; values: Record<string, string> | string[] };
const TYPES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'docs', 'excel', 'types.json'), 'utf8'),
) as { sheet: string; sections: Record<string, Section> };

const wordsOf = (key: string): string[] =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
const normalise = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]/g, '');

const MAPPED: Array<[string, Record<string, number>]> = [
  ['katchupStatus', T.KATCHUP_STATUS],
  ['katchupMessageType', T.KATCHUP_MESSAGE_TYPE],
  ['katchupShareType', T.KATCHUP_SHARE_TYPE],
  ['kallStatus', T.KALL_STATUS],
  ['kallType', T.KALL_TYPE],
  ['kallMode', T.KALL_MODE],
  ['kallRepeatType', T.KALL_REPEAT_TYPE],
  ['kmailType', T.KMAIL_TYPE],
  ['kmailReceiverType', T.KMAIL_RECEIVER_TYPE],
  ['kmailPriority', T.KMAIL_PRIORITY],
  ['module', T.KPOST_MODULE],
  ['kdiaryRemarks', T.KDIARY_REMARKS],
];

test.describe('kpostTypes mirrors the Excel Types tab', () => {
  for (const [section, constants] of MAPPED) {
    test(`${section} matches the workbook in both directions`, () => {
      const excel = TYPES.sections[section]?.values as Record<string, string> | undefined;
      expect(
        excel,
        `section "${section}" is missing from docs/excel/types.json — re-run npm run contract:types`,
      ).toBeDefined();

      for (const [key, value] of Object.entries(constants)) {
        const label = (excel as Record<string, string>)[String(value)];
        expect(
          label,
          `${section}.${key} = ${value} is not a value the workbook lists`,
        ).toBeDefined();
        for (const word of wordsOf(key)) {
          expect(
            normalise(label as string),
            `${section}.${key} = ${value}, but the workbook's label for ${value} is "${label}"`,
          ).toContain(word);
        }
      }

      const ours = Object.values(constants);
      for (const [value, label] of Object.entries(excel as Record<string, string>)) {
        expect(
          ours,
          `the workbook lists ${section} ${value} = "${label}" and no constant carries it`,
        ).toContain(Number(value));
      }
    });
  }


  test('business user tiers match the workbook', () => {
    expect(TYPES.sections.businessUserType?.values).toEqual([...T.BUSINESS_USER_TYPE]);
  });

  test('observed-only values are genuinely absent from the workbook', () => {
    // If the workbook starts listing them, they belong in the documented constants instead.
    const share = TYPES.sections.katchupShareType.values as Record<string, string>;
    const status = TYPES.sections.katchupStatus.values as Record<string, string>;
    expect(share[String(T.KATCHUP_OBSERVED.copiesSharedType)]).toBeUndefined();
    expect(status[String(T.KATCHUP_OBSERVED.recalledStatus)]).toBeUndefined();
  });
});
