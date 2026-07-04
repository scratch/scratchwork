import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** Access expression: "public", "private", or a comma-separated list of emails and @domains. */
export type AccessGroup = "public" | "private" | string;

/** Raised when an access expression cannot be parsed. */
export class AccessGroupError extends Data.TaggedError("AccessGroupError")<{
  readonly message: string;
}> {}

/** The identity an access group is matched against. */
export interface AccessPrincipal {
  readonly email: string;
}

/** One parsed term of an access expression. */
type GroupTerm =
  | { readonly _tag: "Public" }
  | { readonly _tag: "Private" }
  | { readonly _tag: "Email"; readonly email: string }
  | { readonly _tag: "Domain"; readonly domain: string };

/** Normalizes and validates Scratchwork's shared access-expression syntax. */
export function normalizeAccessGroup(group: string): Effect.Effect<AccessGroup, AccessGroupError> {
  const terms = parseAccessGroup(group);
  return terms == null
    ? Effect.fail(new AccessGroupError({ message: `Invalid access group: ${group}` }))
    : Effect.succeed(serializeTerms(terms));
}

/** Returns true when the principal is included by the access group. */
export function accessGroupMatches(group: AccessGroup, principal: AccessPrincipal | null | undefined): boolean {
  const terms = parseAccessGroup(group);
  if (terms == null) return false;
  return terms.some((term) => termMatches(term, principal));
}

/** Returns true when every principal in `candidate` would also be allowed by `ceiling`. */
export function accessGroupIsSubset(candidate: AccessGroup, ceiling: AccessGroup): boolean {
  const candidateTerms = parseAccessGroup(candidate);
  const ceilingTerms = parseAccessGroup(ceiling);
  if (candidateTerms == null || ceilingTerms == null) return false;
  return candidateTerms.every((term) => termIsSubset(term, ceilingTerms));
}

export { isSafeProjectIdentifier, workspaceFromEmail } from "../../../shared/src/site/identifiers";

/** Slugs that collide with server-owned routes and cannot start a project URL. */
const RESERVED_ROUTE_SLUGS: ReadonlySet<string> = new Set(["api", "auth", "health", "favicon.ico", "favicon.svg"]);

/** Returns true when a slug would shadow a server-reserved route prefix (/api, /auth, ...). */
export function isReservedSlug(value: string): boolean {
  return RESERVED_ROUTE_SLUGS.has(value.toLowerCase());
}

/** Checks that every explicit email/domain share target sits within an allowed domain list. */
export function accessGroupUsesOnlyDomains(group: AccessGroup, domains: ReadonlySet<string>): boolean {
  if (domains.size === 0) return true;
  const terms = parseAccessGroup(group);
  if (terms == null) return false;
  for (const term of terms) {
    if (term._tag === "Public") return false;
    if (term._tag === "Private") continue;
    const domain = term._tag === "Domain" ? term.domain : term.email.split("@")[1];
    if (domain == null || !domains.has(domain)) return false;
  }
  return true;
}

/** Parses a comma-separated access expression into validated terms, or null when invalid. */
function parseAccessGroup(group: string): ReadonlyArray<GroupTerm> | null {
  const text = group.trim().toLowerCase();
  if (text === "") return null;
  const parts = text.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) return null;

  const terms: Array<GroupTerm> = [];
  for (const part of parts) {
    if (part === "public") {
      terms.push({ _tag: "Public" });
    } else if (part === "private") {
      terms.push({ _tag: "Private" });
    } else if (part.startsWith("@") && safeDomain(part.slice(1))) {
      terms.push({ _tag: "Domain", domain: part.slice(1) });
    } else if (safeEmail(part)) {
      terms.push({ _tag: "Email", email: part });
    } else {
      return null;
    }
  }

  if (terms.some((term) => term._tag === "Public") && terms.length > 1) return null;
  if (terms.some((term) => term._tag === "Private") && terms.length > 1) return null;
  return dedupeTerms(terms);
}

/** Returns true when the principal satisfies one term. */
function termMatches(term: GroupTerm, principal: AccessPrincipal | null | undefined): boolean {
  if (term._tag === "Public") return true;
  if (term._tag === "Private" || principal == null) return false;
  const email = principal.email.toLowerCase();
  if (term._tag === "Email") return email === term.email;
  return email.endsWith(`@${term.domain}`);
}

/** Returns true when everyone matched by `term` is also matched by some ceiling term. */
function termIsSubset(term: GroupTerm, ceiling: ReadonlyArray<GroupTerm>): boolean {
  if (term._tag === "Private") return true;
  if (ceiling.some((candidate) => candidate._tag === "Public")) return true;
  if (term._tag === "Public") return false;
  if (term._tag === "Email") {
    return ceiling.some((candidate) =>
      candidate._tag === "Email"
        ? candidate.email === term.email
        : candidate._tag === "Domain" && term.email.endsWith(`@${candidate.domain}`),
    );
  }
  return ceiling.some((candidate) => candidate._tag === "Domain" && candidate.domain === term.domain);
}

/** Renders parsed terms back into the canonical expression string. */
function serializeTerms(terms: ReadonlyArray<GroupTerm>): AccessGroup {
  if (terms.length === 1 && terms[0]._tag === "Public") return "public";
  if (terms.length === 1 && terms[0]._tag === "Private") return "private";
  return terms.map((term) =>
    term._tag === "Email"
      ? term.email
      : term._tag === "Domain"
        ? `@${term.domain}`
        : term._tag.toLowerCase()
  ).join(",");
}

/** Removes duplicate terms while preserving first-seen order. */
function dedupeTerms(terms: ReadonlyArray<GroupTerm>): ReadonlyArray<GroupTerm> {
  const seen = new Set<string>();
  const result: Array<GroupTerm> = [];
  for (const term of terms) {
    const key = serializeTerms([term]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(term);
  }
  return result;
}

/** Returns true for a plausible lowercase email with a safe domain. */
function safeEmail(value: string): boolean {
  const [local, domain, extra] = value.split("@");
  return extra == null && local != null && local !== "" && domain != null && safeDomain(domain) && !/[,\s<>]/.test(local);
}

/** Returns true for a plausible lowercase DNS domain. */
function safeDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value);
}
