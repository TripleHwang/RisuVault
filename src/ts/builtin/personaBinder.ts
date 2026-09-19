import type { RisuPlugin } from "../plugins/plugins.svelte";

export const PERSONA_BINDER_PLUGIN_NAME = "persona_binder";

/**
 * Persona Binder is shipped with RisuVault the way PageFold is: a frozen code
 * asset that runs through the API v3 sandbox rather than a row copied into
 * every user database. The bundle is CC BY-NC-SA 4.0 (see NOTICE.md); the
 * blocks marked "RisuVault:" inside it are this repository's patch.
 *
 * Unlike PageFold it is opt-in (`optIn` in the registry): it writes a Temp
 * Persona into the database, hooks every request and polls the chat, none of
 * which a user who never installed it asked for. `enabled: true` here is the
 * shape of the loaded plugin; whether it loads at all is the registry's call.
 *
 * Dynamic import for the same reason as PageFold: nothing needs the source
 * before plugins load, so it stays out of the initial application chunk.
 */
export async function loadBuiltInPersonaBinderPlugin(): Promise<RisuPlugin> {
  const { default: script } = await import("./persona_binder-1.28-fix.js?raw");

  return Object.freeze({
    name: PERSONA_BINDER_PLUGIN_NAME,
    displayName: "Persona Binder (built-in)",
    script,
    arguments: {},
    realArg: {},
    version: "3.0",
    customLink: [],
    argMeta: {},
    versionOfPlugin: "1.28",
    enabled: true,
    builtIn: true,
  });
}
