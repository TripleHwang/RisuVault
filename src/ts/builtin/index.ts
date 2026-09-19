import type { RisuPlugin } from "../plugins/plugins.svelte";
import { loadBuiltInPageFoldPlugin, PAGEFOLD_PLUGIN_NAME } from "./pagefold";
import { loadBuiltInPersonaBinderPlugin, PERSONA_BINDER_PLUGIN_NAME } from "./personaBinder";

export type BuiltInPluginEntry = {
  name: string;
  load: () => Promise<RisuPlugin>;
  /**
   * Off until the user turns it on in the plugin settings. A passive provider
   * such as PageFold only adds a model to the selectors, so it can be on for
   * everyone. An active plugin -- one that writes to the database on launch,
   * registers request hooks that can refuse a send, or polls the chat -- is a
   * change to what the application does for a user who never installed it,
   * and that is the user's call, not the build's.
   */
  optIn: boolean;
};

/**
 * The plugins RisuVault ships as code assets. `loadPlugins` injects each
 * active one ahead of the user's own list, `importPlugin` refuses to install a
 * duplicate by name while the built-in is active, and the API v3 host trusts a
 * frozen plugin carrying one of these names with the permissions and host-only
 * APIs a reviewed built-in gets. Adding a built-in means adding it here and
 * nowhere else.
 */
export const builtInPluginRegistry: ReadonlyArray<BuiltInPluginEntry> = [
  { name: PAGEFOLD_PLUGIN_NAME, load: loadBuiltInPageFoldPlugin, optIn: false },
  { name: PERSONA_BINDER_PLUGIN_NAME, load: loadBuiltInPersonaBinderPlugin, optIn: true },
];

export const BUILT_IN_PLUGIN_NAMES: ReadonlySet<string> = new Set(
  builtInPluginRegistry.map((entry) => entry.name),
);

export const OPT_IN_BUILT_IN_PLUGIN_NAMES: ReadonlySet<string> = new Set(
  builtInPluginRegistry.filter((entry) => entry.optIn).map((entry) => entry.name),
);

export const builtInPluginLoaders: ReadonlyArray<() => Promise<RisuPlugin>> =
  builtInPluginRegistry.map((entry) => entry.load);

/**
 * Whether the built-in of this name runs for this user: always for a plugin
 * that is on for everyone, and for an opt-in one only when its name is in the
 * database's `enabledOptionalBuiltInPlugins`. A name that is not a built-in
 * at all answers false.
 */
export function isBuiltInPluginActive(
  name: string | undefined,
  enabledOptionalBuiltInPlugins: readonly string[] | undefined,
): boolean {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (!BUILT_IN_PLUGIN_NAMES.has(normalized)) return false;
  if (!OPT_IN_BUILT_IN_PLUGIN_NAMES.has(normalized)) return true;
  return Array.isArray(enabledOptionalBuiltInPlugins) && enabledOptionalBuiltInPlugins.includes(normalized);
}

/**
 * Every active built-in that loads, in registry order. One that fails is
 * logged and skipped so the user's installed plugins still load; a bundled
 * asset that cannot be read is a build defect, not a reason to disable the
 * plugin system.
 */
export async function loadBuiltInPlugins(
  enabledOptionalBuiltInPlugins: readonly string[] | undefined = [],
): Promise<RisuPlugin[]> {
  const loaded: RisuPlugin[] = [];
  for (const entry of builtInPluginRegistry) {
    if (!isBuiltInPluginActive(entry.name, enabledOptionalBuiltInPlugins)) continue;
    try {
      loaded.push(await entry.load());
    } catch (error) {
      console.error("[Plugin] a built-in plugin failed to load and is skipped", error);
    }
  }
  return loaded;
}
