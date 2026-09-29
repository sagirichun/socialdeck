/**
 * Adapter registry entry point. Importing this module registers every supported platform.
 * Add a new network by dropping a file next to this one and adding one import line below.
 */
import "./facebook";
import "./instagram";
import "./tiktok";
import "./youtube";
import "./x";
import "./threads";
import "./linkedin";
import "./pinterest";
import "./mastodon";
import "./rtmp";

export * from "./types";
export { listAdapters, getAdapter, loadAccount, persistTokens } from "./types";
