/** Pure policy facade. Data loading/adapters remain in repository/process orchestration. */
export {
  extractPrefilledFields,
  canonicalizeMeetingDurationPrompt,
  meetingDurationContextNote,
  prefilledLeadContextNote,
  prefilledQualificationAcknowledgement,
  initialPrefilledGreetingCorrection,
  prefilledQualificationCompletionCorrection,
  schedulingAvailabilityPolicyCorrection,
  schedulingPeriodQuestionCorrection,
  meetingDurationDisclosureCorrection,
  meetingInvitationContextCorrection
} from "./prefilled-context.js";
