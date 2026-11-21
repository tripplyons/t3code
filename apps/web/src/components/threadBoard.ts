import type { ProviderApprovalOption } from "@t3tools/contracts";

const APPROVAL_KEY_ORDER = ["accept", "decline"];

/** Approval choices in shortcut order: Approve on 1 and Decline on 2, then the rest as offered. */
export function boardApprovalChoices(
  options: ReadonlyArray<ProviderApprovalOption>,
): ProviderApprovalOption[] {
  const rank = (option: ProviderApprovalOption) => {
    const index = APPROVAL_KEY_ORDER.indexOf(option.decision);
    return index === -1 ? APPROVAL_KEY_ORDER.length : index;
  };
  return options.toSorted((left, right) => rank(left) - rank(right)).slice(0, 9);
}
