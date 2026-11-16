import type { EvidenceQuality, SimulationReview } from "./simulation.ts";

export type ReviewFailureReason = "insufficient_evidence" | "review_timeout" | "review_unavailable" | "invalid_review" | "review_limit";

export interface ReviewRecovery {
  answer: string;
  quality: EvidenceQuality;
  failure: { reason: ReviewFailureReason; retryable: true; retryScope: "unfinished_claims" | "review" };
}

/** Only a validated review's independently approved paragraphs can survive a failed repair. */
export function recoverReviewFailure(review: SimulationReview, reference: boolean): ReviewRecovery {
  const reason: ReviewFailureReason = review.reason === "review_timeout" ? "review_timeout"
    : review.reason === "review_unavailable" ? "review_unavailable"
    : review.reason === "review_limit" ? "review_limit"
    : review.reason ? "invalid_review" : "insufficient_evidence";
  const findings = review.status === "needs_revision" && !review.reason ? review.approvedFindings : undefined;
  if (findings?.length) {
    return {
      answer: `I could verify these parts${reference ? " of my previous answer" : ""}:\n\n${findings.map(finding => finding.text).join("\n\n")}\n\nThe remaining claims are still unverified. Retry the unfinished check to investigate them.`,
      quality: "supported_partial",
      failure: { reason, retryable: true, retryScope: "unfinished_claims" },
    };
  }
  const subject = reference ? "The claims in my previous answer in this conversation" : "The requested claims";
  const explanation = reason === "review_timeout" ? "The evidence review timed out before it finished."
    : reason === "review_unavailable" ? "The evidence review is temporarily unavailable."
    : reason === "review_limit" ? "There was too much evidence to review within this check's limits."
    : reason === "invalid_review" ? "The evidence review did not return a usable result."
    : "The available evidence did not establish all the requested facts.";
  return {
    answer: `${explanation} ${subject} remain unverified for the selected date. ${reason === "insufficient_evidence" || reason === "review_limit" ? "Retry a specific claim to narrow the check." : "Retry the review to finish checking them."}`,
    quality: "explicitly_unverified",
    failure: { reason, retryable: true, retryScope: "review" },
  };
}
