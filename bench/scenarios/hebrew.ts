// F5 Hebrew (bench/README.md): `he46`, the BROWSER skeleton with a Hebrew UI: every snapshot uses the gateway-probes
// content.py HEBREW vocabulary for accessible names and a Hebrew page title; O1 in Hebrew (cue `בעצם`, ASCII markers).

import { makeSession, type ScenarioContext, type ScenarioDef } from './common.js';
import { qaWithO1 } from './browser.js';

/** reference-harness/gateway-probes/content.py HEBREW, verbatim. */
export const HEBREW_WORDS: readonly string[] = (
  'המשך לתשלום סל קניות קופון משלוח חיוב כתובת תשלום כרטיס סכום ביניים מס הזמנה סיכום אישור ביטול ' +
  'עדכון בחירה אפשרות כמות פריט מוצר מסירה אקספרס רגיל אריזת מתנה חשבון התחברות אורח דואר טלפון עיר'
).split(' ');

export const HEBREW_TITLE = 'קופה - חנות';

export function he46(_ctx: ScenarioContext): ScenarioDef {
  const { script, facts } = qaWithO1({ id: 'he46', steps: 46, lang: 'he', gen: { words: HEBREW_WORDS, pageTitle: HEBREW_TITLE } });
  return {
    id: 'he46', family: 'F5', sessions: [makeSession(script)], facts, client: 'sim', capBytes: 51_200,
    mock: { render: 'sim' }, gates: [], expect: 'complete', windows: ['100k'],
    description: 'BROWSER skeleton with Hebrew-UI snapshots (content.py HEBREW), Hebrew titles, O1 in Hebrew',
  };
}
