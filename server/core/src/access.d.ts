import * as Effect from "effect/Effect";
/** Access expression: "public", "private", or a comma-separated list of emails and @domains. */
export type AccessGroup = "public" | "private" | string;
declare const AccessGroupError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "AccessGroupError";
} & Readonly<A>;
/** Raised when an access expression cannot be parsed. */
export declare class AccessGroupError extends AccessGroupError_base<{
    readonly message: string;
}> {
}
/** The identity an access group is matched against. */
export interface AccessPrincipal {
    readonly email: string;
}
/** Normalizes and validates Scratchwork's shared access-expression syntax. */
export declare function normalizeAccessGroup(group: string): Effect.Effect<AccessGroup, AccessGroupError>;
/** Returns true when the principal is included by the access group. */
export declare function accessGroupMatches(group: AccessGroup, principal: AccessPrincipal | null | undefined): boolean;
export { isSafeProjectIdentifier } from "@scratchwork/shared/site/identifiers";
/** Returns true when a name is reserved and cannot be claimed as a project. */
export declare function isReservedSlug(value: string): boolean;
/** Applies share/revoke deltas to an access group: adds and removes individual email and
 * @domain grants. Targets must be single email/@domain terms — never `public` or
 * `private`, which are set through publish/unpublish. `public` has no grant list, so
 * grants cannot be added to it, while removals against it are no-ops (there is no grant
 * to remove; the caller's warning machinery reports the retained access). Removals match
 * exact terms only; an email left covered by a remaining domain grant is the caller's to
 * detect (see accessGroupMatches). Removing the last grant yields `private`. */
export declare function accessGroupModify(group: AccessGroup, changes: {
    readonly add: ReadonlyArray<string>;
    readonly remove: ReadonlyArray<string>;
}): Effect.Effect<AccessGroup, AccessGroupError>;
/** Lists a grant group's individual email/@domain terms for API responses. `private`
 * (no grants) and `public` (no grant list) yield an empty list; an unparsable group
 * also yields [] rather than leaking a malformed stored value. */
export declare function accessGroupTerms(group: AccessGroup): ReadonlyArray<string>;
/** Checks that every explicit email/domain share target sits within an allowed domain list. */
export declare function accessGroupUsesOnlyDomains(group: AccessGroup, domains: ReadonlySet<string>): boolean;
/** Returns true for a plausible lowercase DNS domain. */
export declare function safeDomain(value: string): boolean;
