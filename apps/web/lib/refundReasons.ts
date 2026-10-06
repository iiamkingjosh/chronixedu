/**
 * Why a fee refund was made, with the words the bursar sees. The API holds the same list
 * (apps/api/src/db/queries/feeRefunds.ts REFUND_REASONS) and refuses anything else;
 * apps/api/src/__tests__/refundReasons.test.ts checks the two lists are the same, both ways.
 */
export type RefundReason = 'overpaid' | 'paid_twice' | 'withdrew' | 'wrong_child' | 'other';

export const REFUND_REASON_OPTIONS: Array<[RefundReason, string]> = [
  ['overpaid', 'Paid more than owed'],
  ['paid_twice', 'Paid twice'],
  ['withdrew', 'Student withdrew'],
  ['wrong_child', 'Paid for the wrong child'],
  ['other', 'Other'],
];
