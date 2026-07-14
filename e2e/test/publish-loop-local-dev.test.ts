/*
 * Full publish loop against the deploy/local-dev entrypoint: local file
 * storage + in-memory DB behind the real BunHttpServer.
 */
import { publishLoopSuite } from "../src/suite";

publishLoopSuite("local-dev");
