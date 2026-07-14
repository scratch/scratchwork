/*
 * Full publish loop against the production Cloudflare Worker bundle under
 * miniflare/workerd, with real R2 and D1 bindings.
 */
import { publishLoopSuite } from "../src/suite";

publishLoopSuite("cloudflare");
