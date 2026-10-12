// Synthetic expected facts, declared independently of correction scoring.
export const CORRECTION_CASES: Array<{
    name: string;
    older: string;
    later: string;
    superseded: number[];
}> = [
    { name: 'English additive shared ID', older: 'USER-TEST-R1: run the unit tests.', later: 'Actually also run integration tests for USER-TEST-R1.', superseded: [] },
    { name: 'Hebrew additive shared ID', older: 'USER-TEST-R1: תריץ בדיקות יחידה.', later: 'תיקון: גם תריץ בדיקות שילוב עבור USER-TEST-R1.', superseded: [] },
    { name: 'distinct IDs preserve independent instructions', older: 'USER-API-R1: use strict validation for the parser.', later: 'Correction for USER-CLI-R2: use strict validation for the parser.', superseded: [] },
    { name: 'English terse browser cancellation', older: 'Please also run every spec on the firefox project.', later: 'Actually, skip firefox - chromium only is enough.', superseded: [0] },
    { name: 'browser cancellation preserves fixture safety', older: 'Never delete firefox test fixtures.', later: 'Skip firefox.', superseded: [] },
    { name: 'browser cancellation preserves settings safety', older: 'Do not modify firefox settings.', later: 'Skip firefox.', superseded: [] },
    { name: 'browser cancellation with two targets is ambiguous', older: 'Run the firefox payment tests. Run the firefox integration tests.', later: 'Skip firefox.', superseded: [] },
    { name: 'browser cancellation preserves second browser', older: 'Run firefox and chromium tests.', later: 'Skip firefox.', superseded: [] },
    { name: 'browser cancellation preserves compound safety', older: 'Run firefox tests and never delete fixtures.', later: 'Skip firefox.', superseded: [] },
    { name: 'English cancellation one sentence only', older: 'Run the payment tests. Keep the browser tests.', later: 'Cancel the payment tests.', superseded: [0] },
    { name: 'Hebrew cancellation one sentence only', older: 'תריץ בדיקות תשלום. תשמור בדיקות דפדפן.', later: 'בטל בדיקות תשלום.', superseded: [0] },
    { name: 'English negated cancellation', older: 'Run the payment tests.', later: 'Do not cancel the payment tests.', superseded: [] },
    { name: 'English prefixed negated cancellation', older: 'Run the payment tests.', later: 'Actually, do not cancel the payment tests.', superseded: [] },
    { name: 'English correction negated cancellation', older: 'Run the payment tests.', later: 'Correction: do not cancel the payment tests.', superseded: [] },
    { name: 'Hebrew negated cancellation', older: 'תריץ בדיקות תשלום.', later: 'אל תבטל בדיקות תשלום.', superseded: [] },
    { name: 'Hebrew prefixed negated cancellation', older: 'תריץ בדיקות תשלום.', later: 'תיקון: אל תבטל בדיקות תשלום.', superseded: [] },
    { name: 'English distinct browser objects', older: 'Run the firefox payment tests.', later: 'Cancel the firefox telemetry tests.', superseded: [] },
    { name: 'similar object words are not identity', older: 'Run payment integration tests.', later: 'Skip payment unit tests.', superseded: [] },
    { name: 'quoted cancellation', older: 'Run the payment tests.', later: 'The log says "Cancel the payment tests."', superseded: [] },
    { name: 'question is no correction', older: 'Run the payment tests.', later: 'Should we cancel the payment tests?', superseded: [] },
    { name: 'unrelated similar language', older: 'Run the payment tests.', later: 'Cancel the browser tests.', superseded: [] },
];
