import type { CandidatePolicyInput, CandidatePolicyPerson } from "./discovery-types";

export function ageOn(birthDate: string, now: Date) {
  const [year, month, day] = birthDate.split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age -= 1;
  return age;
}

const accepts = (person: CandidatePolicyPerson, other: CandidatePolicyPerson, now: Date) => {
  const age = ageOn(other.birthDate, now);
  return Number.isFinite(age)
    && age >= person.preferences.minimumAge
    && age <= person.preferences.maximumAge
    && (person.preferences.genderCodes.length === 0
      || person.preferences.genderCodes.includes(other.genderCode))
    && ((person.preferences.preferredCountryCodes?.length ?? 0) === 0
      || person.preferences.preferredCountryCodes!.includes(other.countryCode));
};

export function isCandidateEligible(input: CandidatePolicyInput) {
  const now = input.now ?? new Date();
  return input.viewer.userId !== input.candidate.userId
    && !input.viewerBlockedCandidate
    && !input.candidateBlockedViewer
    && !input.disabledRegion
    && (input.candidate.accountStatus ?? "active") === "active"
    && input.candidate.status === "active"
    && input.candidate.discoverable
    && input.candidate.approvedPhotoCount > 0
    && accepts(input.viewer, input.candidate, now)
    && accepts(input.candidate, input.viewer, now);
}
