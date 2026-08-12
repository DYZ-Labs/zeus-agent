import { z } from "zod";

import type { CandidateView } from "./candidates";
import { ResourceId, ReviewItem, type ReviewItem as ReviewItemContract } from "./contracts";
import { resourceId } from "./resource-id";
import type { FactView, UnderstandingFacetView } from "./schema";

export const AboutYouCategory = z.enum([
  "Work",
  "People",
  "Preferences",
  "Places",
  "Plans",
  "Important context",
]);
export type AboutYouCategory = z.infer<typeof AboutYouCategory>;

export const ABOUT_YOU_CATEGORIES: readonly AboutYouCategory[] = [
  "Work",
  "People",
  "Preferences",
  "Places",
  "Plans",
  "Important context",
];

export const AboutYouItem = z
  .object({
    id: ResourceId,
    category: AboutYouCategory,
    statement: z.string().trim().min(1).max(2_000),
    editableText: z.string().max(2_000),
    sourceId: ResourceId.nullable(),
    learnedAt: z.string(),
    endedAt: z.string().nullable(),
    canRestore: z.boolean(),
  })
  .strict();
export type AboutYouItem = z.infer<typeof AboutYouItem>;

export const ConsumerReviewItem = ReviewItem.extend({
  canEdit: z.boolean(),
  editableText: z.string().trim().min(1).max(2_000),
}).strict();
export type ConsumerReviewItem = z.infer<typeof ConsumerReviewItem>;

export type AboutYouGroup = {
  category: AboutYouCategory;
  items: AboutYouItem[];
};

export function aboutYouItemForFact(fact: FactView): AboutYouItem {
  return AboutYouItem.parse({
    id: resourceId("fact", fact.id),
    category: categoryForFact(fact),
    statement: factStatement(fact.subject_slug === "self" ? "You" : fact.subject_name, fact.predicate, fact.object),
    editableText: fact.object,
    sourceId: fact.source_message_id === null ? null : resourceId("message", fact.source_message_id),
    learnedAt: fact.created_at,
    endedAt: fact.valid_to,
    canRestore: fact.valid_to !== null,
  });
}

export function aboutYouItemForFacet(facet: UnderstandingFacetView): AboutYouItem {
  return AboutYouItem.parse({
    id: resourceId("facet", facet.id),
    category: categoryForFacet(facet),
    statement: sentence(facet.statement),
    editableText: facet.statement,
    sourceId: resourceId("message", facet.source_message_id),
    learnedAt: facet.created_at,
    endedAt: facet.valid_to,
    canRestore: false,
  });
}

export function groupAboutYouItems(items: readonly AboutYouItem[]): AboutYouGroup[] {
  return ABOUT_YOU_CATEGORIES.map((category) => ({
    category,
    items: items
      .filter((item) => item.category === category)
      .sort((left, right) => right.learnedAt.localeCompare(left.learnedAt)),
  })).filter((group) => group.items.length > 0);
}

export function reviewItemForCandidate(
  candidate: CandidateView,
  sourceDates: ReadonlyMap<number, string> = new Map(),
): ConsumerReviewItem {
  const evidence = candidate.evidence.length > 0
    ? candidate.evidence.map((passage) => ({
        quote: passage.text,
        date: sourceDates.get(passage.message_id) ?? passage.created_at,
        sourceId: resourceId("message", passage.message_id),
      }))
    : [
        {
          quote: candidate.source_excerpt,
          date: sourceDates.get(candidate.source_message_id) ?? candidate.created_at,
          sourceId: resourceId("message", candidate.source_message_id),
        },
      ];

  return ConsumerReviewItem.parse({
    id: resourceId("candidate", candidate.id),
    category: categoryForCandidate(candidate),
    statement: statementForCandidate(candidate),
    reason: reviewReason(candidate),
    evidence,
    canEdit: true,
    editableText: editableCandidateText(candidate),
  } satisfies ReviewItemContract & { canEdit: boolean; editableText: string });
}

function editableCandidateText(candidate: CandidateView): string {
  const payload = candidatePayload(candidate.payload);
  return candidate.kind === "fact" || candidate.kind === "interest"
    ? stringValue(payload.object, statementForCandidate(candidate))
    : candidate.kind === "facet"
      ? stringValue(payload.statement, statementForCandidate(candidate))
      : stringValue(payload.title, statementForCandidate(candidate));
}

function categoryForFact(fact: Pick<FactView, "predicate" | "subject_slug">): AboutYouCategory {
  const predicate = normalizedKey(fact.predicate);
  if (fact.subject_slug !== "self") return "People";
  if (matches(predicate, PLACE_WORDS)) return "Places";
  if (matches(predicate, PREFERENCE_WORDS)) return "Preferences";
  if (matches(predicate, PLAN_WORDS)) return "Plans";
  if (matches(predicate, PEOPLE_WORDS)) return "People";
  if (matches(predicate, WORK_WORDS)) return "Work";
  return "Important context";
}

function categoryForFacet(
  facet: Pick<UnderstandingFacetView, "kind" | "scope_kind" | "scope_label">,
): AboutYouCategory {
  if (facet.scope_kind === "entity" || facet.kind === "relationship_dynamic") return "People";
  if (facet.scope_kind === "goal" || facet.scope_kind === "commitment") return "Plans";
  if (facet.scope_kind === "domain" && /\b(?:work|career|job|business)\b/iu.test(facet.scope_label ?? "")) {
    return "Work";
  }
  if (["preference", "communication_style", "working_style", "routine"].includes(facet.kind)) {
    return "Preferences";
  }
  if (facet.kind === "skill") return "Work";
  return "Important context";
}

function categoryForCandidate(candidate: CandidateView): AboutYouCategory {
  if (candidate.kind === "goal" || candidate.kind === "commitment") return "Plans";
  if (candidate.kind === "interest") return "Preferences";
  const payload = candidatePayload(candidate.payload);
  if (candidate.kind === "facet") {
    const scope = recordValue(payload.scope);
    return categoryForFacet({
      kind: stringValue(payload.kind, "value") as UnderstandingFacetView["kind"],
      scope_kind: stringValue(scope.kind, "global") as UnderstandingFacetView["scope_kind"],
      scope_label: stringValue(scope.label, "") || null,
    });
  }
  return categoryForFact({
    predicate: stringValue(payload.predicate, ""),
    subject_slug: isSelfLabel(stringValue(payload.subject, "you")) ? "self" : "person",
  });
}

function statementForCandidate(candidate: CandidateView): string {
  const payload = candidatePayload(candidate.payload);
  if (candidate.kind === "fact" || candidate.kind === "interest") {
    return factStatement(
      stringValue(payload.subject, "You"),
      stringValue(payload.predicate, "is"),
      stringValue(payload.object, "this"),
    );
  }
  if (candidate.kind === "facet") {
    return sentence(stringValue(payload.statement, "Review this proposed detail"));
  }
  const title = stringValue(payload.title, "Review this proposed plan");
  return sentence(candidate.kind === "commitment" ? `You plan to ${lowercaseStart(title)}` : `You want to ${lowercaseStart(title)}`);
}

function reviewReason(candidate: CandidateView): ReviewItemContract["reason"] {
  if (candidate.reasons.includes("sensitive")) return "sensitive";
  if (candidate.reasons.includes("conflict")) return "conflict";
  if (candidate.reasons.includes("ambiguous")) return "ambiguous";
  return "uncertain";
}

function factStatement(subject: string, predicate: string, object: string): string {
  const self = isSelfLabel(subject);
  const key = normalizedKey(predicate);
  const subjectLabel = self ? "You" : subject.trim() || "Someone you know";
  const possessive = self ? "Your" : `${subjectLabel}’s`;
  const template = FACT_TEMPLATES[key];
  if (template) return sentence(template({ subject: subjectLabel, possessive, object, self }));

  const phrase = humanize(key || "detail");
  return sentence(self ? `About you: ${phrase} ${object}` : `${subjectLabel}: ${phrase} ${object}`);
}

type FactTemplateInput = {
  subject: string;
  possessive: string;
  object: string;
  self: boolean;
};

const FACT_TEMPLATES: Readonly<Record<string, (input: FactTemplateInput) => string>> = {
  works_at: ({ subject, object, self }) => `${subject} ${self ? "work" : "works"} at ${object}`,
  job_title: ({ possessive, object }) => `${possessive} job title is ${object}`,
  lives_in: ({ subject, object, self }) => `${subject} ${self ? "live" : "lives"} in ${object}`,
  located_in: ({ subject, object, self }) => `${subject} ${self ? "are" : "is"} based in ${object}`,
  from: ({ subject, object, self }) => `${subject} ${self ? "are" : "is"} from ${object}`,
  timezone: ({ possessive, object }) => `${possessive} time zone is ${object}`,
  birthday: ({ possessive, object }) => `${possessive} birthday is ${object}`,
  likes: ({ subject, object, self }) => `${subject} ${self ? "like" : "likes"} ${object}`,
  dislikes: ({ subject, object, self }) => `${subject} ${self ? "don’t like" : "doesn’t like"} ${object}`,
  prefers: ({ subject, object, self }) => `${subject} ${self ? "prefer" : "prefers"} ${object}`,
  knows: ({ subject, object, self }) => `${subject} ${self ? "know" : "knows"} ${object}`,
  works_with: ({ subject, object, self }) => `${subject} ${self ? "work" : "works"} with ${object}`,
  reports_to: ({ subject, object, self }) => `${subject} ${self ? "report" : "reports"} to ${object}`,
  manages: ({ subject, object, self }) => `${subject} ${self ? "manage" : "manages"} ${object}`,
  works_on: ({ subject, object, self }) => `${subject} ${self ? "are" : "is"} working on ${object}`,
  cares_about: ({ subject, object, self }) => `${subject} ${self ? "care" : "cares"} about ${object}`,
  goal: ({ subject, object, self }) => `${subject} ${self ? "want" : "wants"} to ${object}`,
  relationship_to_user: ({ subject, object }) => `${subject} is ${object} to you`,
  status: ({ subject, object, self }) => `${subject} ${self ? "are" : "is"} ${object}`,
  note: ({ subject, object }) => `${subject}: ${object}`,
  wants: ({ subject, object, self }) => `${subject} ${self ? "want" : "wants"} ${object}`,
  needs: ({ subject, object, self }) => `${subject} ${self ? "need" : "needs"} ${object}`,
  has: ({ subject, object, self }) => `${subject} ${self ? "have" : "has"} ${object}`,
  is: ({ subject, object, self }) => `${subject} ${self ? "are" : "is"} ${object}`,
};

const PLACE_WORDS = ["lives", "location", "located", "place", "city", "country", "hometown", "timezone", "from"];
const PREFERENCE_WORDS = ["like", "dislike", "prefer", "favorite", "favourite", "interest", "enjoy", "care"];
const PLAN_WORDS = ["works_on", "working_on", "plans", "goal", "project", "building", "wants_to"];
const PEOPLE_WORDS = ["knows", "friend", "family", "partner", "spouse", "colleague", "reports_to", "manages", "works_with"];
const WORK_WORDS = ["work", "job", "career", "role", "profession", "employer", "company", "industry", "skill"];

function matches(value: string, words: readonly string[]): boolean {
  return words.some((word) => value === word || value.includes(word));
}

function candidatePayload(value: unknown): Record<string, unknown> {
  const envelope = recordValue(value);
  return "item" in envelope ? recordValue(envelope.item) : envelope;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s-]+/gu, "_");
}

function isSelfLabel(value: string): boolean {
  return ["self", "you", "me", "user", "the_user"].includes(normalizedKey(value));
}

function humanize(value: string): string {
  return value.replace(/_/gu, " ").replace(/\s+/gu, " ").trim();
}

function lowercaseStart(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed[0]!.toLocaleLowerCase()}${trimmed.slice(1)}` : trimmed;
}

function sentence(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "Saved detail.";
  return /[.!?…]$/u.test(normalized) ? normalized : `${normalized}.`;
}
