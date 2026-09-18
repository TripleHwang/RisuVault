import type { RisuPlugin } from "../plugins/plugins.svelte";

export const PAGEFOLD_PLUGIN_NAME = "pagefold";
export const PAGEFOLD_PROVIDER_NAME = "PageFold";

/**
 * PageFold is shipped with RisuVault instead of being copied into every user
 * database. It still runs through the API v3 sandbox, so the provider keeps
 * the same permission and isolation boundaries as an installed plugin.
 *
 * Keep the large provider source behind a dynamic import. The settings/model
 * UI only needs its registration after plugins are loaded, so this keeps it
 * out of the initial application chunk without changing provider semantics.
 */
export async function loadBuiltInPageFoldPlugin(): Promise<RisuPlugin> {
  const { default: script } = await import("./pagefold-0.2.5-fix.js?raw");

  return Object.freeze({
    name: PAGEFOLD_PLUGIN_NAME,
    displayName: "PageFold (built-in)",
    script,
    arguments: {},
    realArg: {},
    version: "3.0",
    customLink: [],
    argMeta: {},
    versionOfPlugin: "0.2.5",
    enabled: true,
    builtIn: true,
  });
}
