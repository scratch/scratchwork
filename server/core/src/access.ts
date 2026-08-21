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
    ? Effect.fail(new AccessGroupError({ message: explainInvalidAccessGroup(group) }))
    : Effect.succeed(serializeTerms(terms));
}

/** Returns true when the principal is included by the access group. */
export function accessGroupMatches(group: AccessGroup, principal: AccessPrincipal | null | undefined): boolean {
  const terms = parseAccessGroup(group);
  if (terms == null) return false;
  return terms.some((term) => termMatches(term, principal));
}

export { isSafeProjectIdentifier } from "@scratchwork/shared/site/identifiers";

/** Names that cannot be claimed as projects. Projects live at single top-level path
 * segments, so a project name is also a root path on the content host: server-owned
 * routes, host-wide root files (a project named "robots.txt" would control crawl policy
 * for the whole host), and prefixes held back for possible future namespace features
 * (gh/g and the auth-provider names) are all off limits. Names are permanent once
 * claimed, so reserve before shipping, not after. This is route policy, not identifier
 * grammar — the CLI must not hardcode it. Separately, the identifier grammar requires an
 * alphanumeric first character, so every "_"- and "."-prefixed name (including
 * ".well-known") is unclaimable without an entry here. */
const RESERVED_ROUTE_SLUGS: ReadonlySet<string> = new Set([
  // Server-owned routes.
  "api", "auth", "health", "favicon.ico", "favicon.svg", "mcp", "oauth",
  // Host-wide root files.
  "robots.txt", "sitemap.xml", "ads.txt", "app-ads.txt", "security.txt",
  // Future namespace prefixes.
  "gh", "g",
  // Auth/identity providers, same future-namespace rationale.
  "github", "gitlab", "gl", "bitbucket", "bb", "google", "microsoft", "ms", "apple",
  "okta", "auth0", "x", "twitter", "facebook", "fb", "linkedin", "li", "slack", "discord",
]);

/** Returns true when a name is reserved and cannot be claimed as a project. */
export function isReservedSlug(value: string): boolean {
  return RESERVED_ROUTE_SLUGS.has(value.toLowerCase());
}

/** Applies share/revoke deltas to an access group: adds and removes individual email and
 * @domain grants. Targets must be single email/@domain terms — never `public` or
 * `private`, which are set through publish/unpublish. `public` has no grant list, so
 * grants cannot be added to it, while removals against it are no-ops (there is no grant
 * to remove; the caller's warning machinery reports the retained access). Removals match
 * exact terms only; an email left covered by a remaining domain grant is the caller's to
 * detect (see accessGroupMatches). Removing the last grant yields `private`. */
export function accessGroupModify(
  group: AccessGroup,
  changes: { readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> },
): Effect.Effect<AccessGroup, AccessGroupError> {
  const current = parseAccessGroup(group);
  if (current == null) {
    return Effect.fail(new AccessGroupError({ message: explainInvalidAccessGroup(group) }));
  }

  const additions = grantTerms(changes.add);
  const removals = grantTerms(changes.remove);
  if (additions instanceof AccessGroupError) return Effect.fail(additions);
  if (removals instanceof AccessGroupError) return Effect.fail(removals);

  if (current.some((term) => term._tag === "Public")) {
    if (additions.length > 0) {
      return Effect.fail(new AccessGroupError({
        message: 'This group is "public", which has no per-account grants to edit. Make the project private first (scratchwork publish --private or unpublish).',
      }));
    }
    return Effect.succeed("public");
  }

  const removedKeys = new Set(removals.map((term) => serializeTerms([term])));
  const terms = dedupeTerms([
    ...current.filter((term) => term._tag !== "Private" && !removedKeys.has(serializeTerms([term]))),
    ...additions,
  ]);
  return Effect.succeed(terms.length === 0 ? "private" : serializeTerms(terms));
}

/** Lists a grant group's individual email/@domain terms for API responses. `private`
 * (no grants) and `public` (no grant list) yield an empty list; an unparsable group
 * also yields [] rather than leaking a malformed stored value. */
export function accessGroupTerms(group: AccessGroup): ReadonlyArray<string> {
  const terms = parseAccessGroup(group);
  if (terms == null) return [];
  return terms
    .filter((term) => term._tag === "Email" || term._tag === "Domain")
    .map((term) => serializeTerms([term]));
}

/** Parses share/revoke targets, each of which must be one email or @domain term. */
function grantTerms(targets: ReadonlyArray<string>): ReadonlyArray<GroupTerm> | AccessGroupError {
  const terms: Array<GroupTerm> = [];
  for (const target of targets) {
    const parsed = parseAccessGroup(target);
    const term = parsed != null && parsed.length === 1 ? parsed[0] : null;
    if (term == null || (term._tag !== "Email" && term._tag !== "Domain")) {
      return new AccessGroupError({
        message: `Invalid share target: ${target} (expected an email address or an @domain group like @example.com)`,
      });
    }
    terms.push(term);
  }
  return terms;
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

/** The error message for an unparsable access expression: what was given, what is accepted. */
function explainInvalidAccessGroup(group: string): string {
  return `Invalid access group "${group}": expected "public", "private", or a comma-separated list of email addresses and @domain groups, like "alice@example.com,@example.com"`;
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
export function safeDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value);
}
