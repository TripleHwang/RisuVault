import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

import { loadBuiltInPersonaBinderPlugin, PERSONA_BINDER_PLUGIN_NAME } from "./personaBinder";
import { BUILT_IN_PLUGIN_NAMES, builtInPluginLoaders, isBuiltInPluginActive, loadBuiltInPlugins, OPT_IN_BUILT_IN_PLUGIN_NAMES } from "./index";
import { PAGEFOLD_PLUGIN_NAME } from "./pagefold";
import { markPluginChatSnapshot, writePluginChatToSlot } from "../plugins/pluginChatAccess";
import { setSqlWindow } from "../storage/sql/sqlRuntimeWindow";

describe("built-in Persona Binder", () => {
  let plugin: Awaited<ReturnType<typeof loadBuiltInPersonaBinderPlugin>>;

  beforeAll(async () => {
    plugin = await loadBuiltInPersonaBinderPlugin();
  });

  test("ships the API v3 plugin frozen, without persisting it in user data", () => {
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(plugin).toMatchObject({
      name: "persona_binder",
      displayName: "Persona Binder (built-in)",
      version: "3.0",
      versionOfPlugin: "1.28",
      enabled: true,
      builtIn: true,
      arguments: {},
      realArg: {},
      customLink: [],
      argMeta: {},
    });
    expect(plugin.id).toBeUndefined();
    expect(plugin.updateURL).toBeUndefined();
    expect(plugin.script).toContain("//@name persona_binder");
    expect(plugin.script).toContain("//@api 3.0");
    expect(plugin.script).toContain("//@version 1.28");
    expect(plugin.script).toContain('const TEMP_PERSONA_ID = "persona-binder-temp-persona"');
    expect(plugin.script).toContain('const BINDING_COMMENT = "[PersonaBinder]"');
  });

  test("keeps the upstream license header first and marks every patch block", () => {
    const { script } = plugin;
    // The upstream 1.28 header, verbatim: metadata lines, then the CC BY-NC-SA
    // 4.0 block. Nothing of RisuVault's comes before it.
    const header = [
      "//@name persona_binder",
      "//@display-name Persona Binder v1.28",
      "//@api 3.0",
      "//@version 1.28",
      "",
      "/**",
      " * 이 저작물은 CC BY-NC-SA 4.0 라이선스에 따라 이용할 수 있습니다.",
      " * https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ko",
      " *",
      " * 본 저작물은 아카라이브 AI 채팅 채널을 위해 공개되었습니다.",
      " * AI 채팅 채널 외부에 공유, 배포, 인용할 경우 원 저작자와 출처를 명시해야 합니다.",
      " *",
      " * 상업적 이용은 허용되지 않습니다.",
      " * 수정, 변형, 2차 저작물을 공유할 경우 동일한 라이선스를 적용해야 합니다.",
      " */",
    ].join("\n");
    expect(script.startsWith(header)).toBe(true);
    // The patch summary follows the header and precedes the module body.
    const summaryAt = script.indexOf("// RisuVault: this is the copy RisuVault ships as a built-in.");
    expect(summaryAt).toBeGreaterThan(header.length);
    expect(summaryAt).toBeLessThan(script.indexOf("(async () => {"));
  });

  test("carries the RisuVault patch blocks", () => {
    const { script } = plugin;
    // P1: the host preset provider, first in the list and the fresh-install default.
    expect(script).toContain('const PRESET_PROVIDER = "risuvault-preset"');
    expect(script).toContain("provider: PRESET_PROVIDER,");
    expect(script).toMatch(/<select id="pb-trans-provider">\s*<option value="\$\{PRESET_PROVIDER\}"/);
    expect(script).toContain("RisuVault 모델 프리셋");
    expect(script).toContain("Risuai.listModelPresets()");
    expect(script).toContain("Risuai.runModelPreset(request, options.abortSignal)");
    // The other providers are untouched.
    for (const provider of ["risu", "google-ai", "openai", "vertex-ai", "custom-api"]) {
      expect(script).toContain(`settings.provider === "${provider}"`);
    }
    // P2: the automatic refresh.
    expect(script).toContain("const PERSONA_REFRESH_PROMPT = [");
    expect(script).toContain('await Risuai.addRisuReplacer("afterRequest", state.afterRequestHandler)');
    expect(script).toContain('await Risuai.addRisuChatListener("output", state.autoAdaptOutputListener)');
    expect(script).toContain("async function runAutoAdaptation(contextKey, controller)");
    // The refresh write never refuses a send that lands during it.
    expect(script).toContain("autoAdaptWriteInProgress: false,");
    expect(script).toContain("state.syncing || (state.bindingMutationInProgress && !state.autoAdaptWriteInProgress)");
    const runAutoAdaptationBody = script.slice(
      script.indexOf("async function runAutoAdaptation(contextKey, controller)"),
      script.indexOf("async function initialize()"),
    );
    expect(runAutoAdaptationBody).not.toContain("withBindingMutation(");
    expect(runAutoAdaptationBody).toContain("state.autoAdaptWriteInProgress = true;");
    expect(script).toContain("자동 갱신 사용");
    // The adaptation and the refresh share one rewrite path.
    expect(script.match(/requestPersonaRewrite\(/g)).toHaveLength(3);
    // The LLM is never called from beforeRequest: the only model calls are the
    // provider functions and the two rewrite callers.
    const beforeRequestBody = script.slice(
      script.indexOf("async function beforeRequest(messages, type)"),
      script.indexOf("async function bindSelectedPersonaToCurrentChat()"),
    );
    expect(beforeRequestBody).not.toContain("callConfiguredAi");
    expect(beforeRequestBody).not.toContain("runModelPreset");
    expect(beforeRequestBody).not.toContain("runLLMModel");
  });

  test("is registered as a built-in beside PageFold, off until the user turns it on", async () => {
    expect(PERSONA_BINDER_PLUGIN_NAME).toBe("persona_binder");
    expect([...BUILT_IN_PLUGIN_NAMES]).toEqual([PAGEFOLD_PLUGIN_NAME, PERSONA_BINDER_PLUGIN_NAME]);
    expect([...OPT_IN_BUILT_IN_PLUGIN_NAMES]).toEqual([PERSONA_BINDER_PLUGIN_NAME]);
    expect(builtInPluginLoaders).toHaveLength(2);

    // An active plugin that writes personas and hooks requests is not
    // switched on for a user who never installed it: a fresh database (and
    // one written before the field existed) loads PageFold only.
    expect((await loadBuiltInPlugins()).map((p) => p.name)).toEqual([PAGEFOLD_PLUGIN_NAME]);
    expect((await loadBuiltInPlugins(undefined)).map((p) => p.name)).toEqual([PAGEFOLD_PLUGIN_NAME]);
    expect(isBuiltInPluginActive(PAGEFOLD_PLUGIN_NAME, [])).toBe(true);
    expect(isBuiltInPluginActive(PERSONA_BINDER_PLUGIN_NAME, [])).toBe(false);
    expect(isBuiltInPluginActive(PERSONA_BINDER_PLUGIN_NAME, undefined)).toBe(false);
    expect(isBuiltInPluginActive("Persona_Binder ", [PERSONA_BINDER_PLUGIN_NAME])).toBe(true);
    expect(isBuiltInPluginActive("something_else", [PERSONA_BINDER_PLUGIN_NAME])).toBe(false);

    const loaded = await loadBuiltInPlugins([PERSONA_BINDER_PLUGIN_NAME]);
    expect(loaded.map((p) => p.name)).toEqual([PAGEFOLD_PLUGIN_NAME, PERSONA_BINDER_PLUGIN_NAME]);
    expect(loaded.every((p) => Object.isFrozen(p) && p.builtIn === true)).toBe(true);
  });

  test("the loader injects every active built-in and refuses a duplicate install only while the built-in is active", () => {
    const source = readFileSync("src/ts/plugins/plugins.svelte.ts", "utf8");
    expect(source).toContain("const builtInPlugins = await loadBuiltInPlugins(db.enabledOptionalBuiltInPlugins)");
    expect(source).toContain("...builtInPlugins,");
    // An installed copy of an opt-in built-in keeps running until the user
    // turns the built-in on; only then is it ignored and a new install refused.
    expect(source).toContain("p.enabled && !isBuiltInPluginActive(p.name)");
    expect(source).toContain("if (installed.enabled && isBuiltInPluginActive(installed.name)) {");
    expect(source).toContain("if (isBuiltInPluginActive(name)) {");
    expect(source).toContain("isBuiltInPluginActiveIn(name, getDatabase()?.enabledOptionalBuiltInPlugins)");
    expect(source).toContain("BUILT_IN_PLUGIN_NAMES.has(name?.trim().toLowerCase() ?? '')");
    expect(source).toContain("is built in and cannot be installed as a separate plugin.");

    // The switch itself: a database default, and a toggle on the plugin page
    // with a label in both languages the plugin page ships.
    expect(readFileSync("src/ts/storage/database.svelte.ts", "utf8")).toContain("data.enabledOptionalBuiltInPlugins ??= []");
    const page = readFileSync("src/lib/Setting/Pages/PluginSettings.svelte", "utf8");
    expect(page).toContain("DBState.db.enabledOptionalBuiltInPlugins = enabled ? [...current, name] : current");
    expect(page).toContain("language.builtInPersonaBinder");
    for (const lang of ["en", "ko"]) {
      const strings = readFileSync(`src/lang/${lang}.ts`, "utf8");
      expect(strings).toMatch(/builtInPlugins:/);
      expect(strings).toMatch(/builtInPersonaBinder:/);
      expect(strings).toMatch(/builtInPersonaBinderDescription:/);
    }

    const apiSource = readFileSync("src/ts/plugins/apiV3/v3.svelte.ts", "utf8");
    expect(apiSource).toContain("plugin.builtIn && BUILT_IN_PLUGIN_NAMES.has(plugin.name) && Object.isFrozen(plugin)");

    const notice = readFileSync("NOTICE.md", "utf8");
    expect(notice).toContain("## Bundled Persona Binder");
    expect(notice).toContain("persona_binder-1.28-fix.js");
    expect(notice).toContain("CC BY-NC-SA 4.0");
  });
});

describe("built-in Persona Binder under a mock host", () => {
  // Runs the whole bundle against a stub of the API v3 host: a character with
  // one chat that carries a binding and whose message history is a partial
  // window, the way RisuVault opens a long conversation. The chat write-back
  // goes through the host's real `writePluginChatToSlot`, so a plugin write
  // that rebuilt the message array would be refused here as in production.
  type Store = Map<string, unknown>;
  type Replacer = (value: any, type: string) => Promise<any>;
  type ChatOutputListener = (arg: { chat: any; characterIndex: number; chatIndex: number; messageIndex: number }) => Promise<void>;
  type PresetCall = { presetId: string; messages: { role: string; content: string }[]; chatId?: string; temperature?: number };

  const TEMP_PERSONA_ID = "persona-binder-temp-persona";
  const BINDING_COMMENT = "[PersonaBinder]";
  const SETTINGS_KEY = "persona_binder_translation_settings_v1";
  const ORIGINAL_PROMPT = "Alice is a wandering knight who never removes her gauntlets.";
  const MARKER = /<<<PERSONA_BINDER_CHANGE_SUMMARY_[a-z0-9]+>>>/i;

  const storage = (store: Store) => ({
    getItem: async (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: async (key: string, value: unknown) => void store.set(key, value),
    removeItem: async (key: string) => void store.delete(key),
  });

  const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function until(condition: () => boolean, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!condition()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("condition not met in time");
      await wait(5);
    }
  }

  /** A well-formed model answer for the adaptation contract, marker taken from the request. */
  function rewriteAnswer(call: PresetCall, prompt: string, changes: string[]) {
    const marker = call.messages[0].content.match(MARKER)?.[0];
    expect(marker).toBeDefined();
    return `${prompt}\n${marker}\n${JSON.stringify({ changes })}`;
  }

  function makeChat(bindingOverrides: Record<string, unknown> = {}) {
    const binding = {
      version: 1,
      chatId: "chat-1",
      createdAt: 1000,
      updatedAt: 1000,
      userMemo: "",
      boundPersona: { name: "Alice", personaPrompt: ORIGINAL_PROMPT, icon: "", largePortrait: false },
      ...bindingOverrides,
    };
    const message = [];
    for (let i = 0; i < 6; i++) {
      message.push({ role: i % 2 === 0 ? "user" : "char", data: `line ${i}`, chatId: `m-${394 + i}` });
    }
    const chat: any = {
      id: "chat-1",
      name: "Chat one",
      message,
      localLore: [{ key: "", comment: BINDING_COMMENT, content: JSON.stringify(binding), mode: "normal", insertorder: 100, alwaysActive: false, secondkey: "", selective: false }],
      bindedPersona: TEMP_PERSONA_ID,
      messagesLoaded: true,
      messagesFullyLoaded: false,
      detailsLoaded: true,
    };
    // Newest 6 of 400 resident, as the SQL loader leaves a long chat.
    setSqlWindow(chat, { before: null, nextBefore: 394, total: 400, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 400 });
    return chat;
  }

  /** Through the live slot: a host write replaces the slot object, so a captured chat goes stale. */
  function readBinding(h: { character: any }) {
    const entry = h.character.chats[0].localLore.find((e: any) => e.comment === BINDING_COMMENT);
    return entry ? JSON.parse(entry.content) : null;
  }

  type BootOptions = {
    settings?: Record<string, unknown>;
    withChatListener?: boolean;
    runModelPreset?: (call: PresetCall) => Promise<{ success: boolean; content: string; error?: string }>;
    runLLMModel?: (arg: any) => Promise<any>;
  };

  let unload: (() => Promise<void>) | null = null;
  let previousRisuai: unknown;

  afterEach(async () => {
    if (unload) {
      await unload();
      unload = null;
    }
    (globalThis as any).Risuai = previousRisuai;
  });

  async function boot(options: BootOptions = {}) {
    const saveStore: Store = new Map();
    const localStore: Store = new Map();
    const legacyStore: Store = new Map();
    if (options.settings) saveStore.set(SETTINGS_KEY, JSON.stringify(options.settings));

    const chat = makeChat();
    const character: any = { chaId: "char-1", name: "Bram", desc: "A gruff innkeeper.", chats: [chat], globalLore: [], detailsLoaded: true };
    const db: any = { personas: [{ id: "p-1", name: "Alice", personaPrompt: ORIGINAL_PROMPT, icon: "", largePortrait: false }], selectedPersona: 0 };
    const replacers = new Map<string, Replacer>();
    const outputListeners = new Set<ChatOutputListener>();
    const unloadCallbacks: Array<() => Promise<void>> = [];
    const runModelPreset = vi.fn(options.runModelPreset ?? (async (call: PresetCall) => ({ success: true, content: rewriteAnswer(call, "Alice is a knight, now limping on a bandaged left leg.", ["왼쪽 다리 부상"]) })));
    const runLLMModel = vi.fn(options.runLLMModel ?? (async () => ({ type: "success", result: "" })));
    const setChatToIndex = vi.fn(async (_characterIndex: number, chatIndex: number, incoming: any) => {
      writePluginChatToSlot(character.chats, chatIndex, incoming);
    });

    const registered = new Promise<void>((resolve, reject) => {
      const originalLog = console.log;
      console.log = (...parts: unknown[]) => {
        if (String(parts[1]).includes("initialized")) {
          console.log = originalLog;
          resolve();
        } else if (String(parts[1]).includes("Initialization failed")) {
          console.log = originalLog;
          reject(new Error(parts.map(String).join(" ")));
        }
      };
    });

    const host: any = {
      requestPluginPermission: async (name: string) => name === "db" || name === "replacer",
      safeLocalStorage: storage(legacyStore),
      pluginStorage: storage(saveStore),
      getLocalPluginStorage: async () => storage(localStore),
      registerButton: async () => {},
      getDatabase: async () => ({ personas: db.personas, selectedPersona: db.selectedPersona }),
      setDatabaseLite: async (patch: any) => Object.assign(db, patch),
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => 0,
      getChatFromIndex: async (_characterIndex: number, chatIndex: number) => {
        const live = character.chats[chatIndex];
        return live ? markPluginChatSnapshot(live, JSON.parse(JSON.stringify(live))) : null;
      },
      setChatToIndex,
      getCharacterFromIndex: async () => JSON.parse(JSON.stringify(character)),
      addRisuReplacer: async (name: string, fn: Replacer) => void replacers.set(name, fn),
      removeRisuReplacer: async (name: string) => void replacers.delete(name),
      onUnload: async (fn: () => Promise<void>) => void unloadCallbacks.push(fn),
      listModelPresets: async () => [{ id: "preset-1", name: "Refresh preset" }],
      runModelPreset,
      runLLMModel,
    };
    if (options.withChatListener !== false) {
      host.addRisuChatListener = async (_mode: string, fn: ChatOutputListener) => void outputListeners.add(fn);
      host.removeRisuChatListener = async (_mode: string, fn: ChatOutputListener) => void outputListeners.delete(fn);
    }

    const { script } = await loadBuiltInPersonaBinderPlugin();
    previousRisuai = (globalThis as any).Risuai;
    (globalThis as any).Risuai = host;
    unload = async () => {
      for (const cb of unloadCallbacks) await cb();
    };
    new Function(script)();
    await registered;
    // The start-up reconcile writes the binding once (temp persona sync); wait it out.
    await until(() => db.personas.some((p: any) => p.id === TEMP_PERSONA_ID));
    setChatToIndex.mockClear();

    const afterRequest = async (type = "model") => replacers.get("afterRequest")!("reply text", type);
    const commitReply = async () => {
      for (const listener of outputListeners) {
        await listener({ chat: { id: chat.id }, characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1 });
      }
    };
    return { chat, character, db, replacers, outputListeners, runModelPreset, runLLMModel, setChatToIndex, afterRequest, commitReply };
  }

  const presetSettings = { provider: "risuvault-preset", presetId: "preset-1", autoAdaptInterval: 10 };

  test("counts committed replies and refreshes the bound persona through the chosen preset on the 10th", async () => {
    const h = await boot({ settings: presetSettings });

    for (let i = 0; i < 9; i++) await h.commitReply();
    expect(readBinding(h).autoAdapt.turnsSinceAdapt).toBe(9);
    // Counting is bookkeeping: the edit stamp is untouched.
    expect(readBinding(h).updatedAt).toBe(1000);
    expect(h.runModelPreset).not.toHaveBeenCalled();

    await h.commitReply();
    await until(() => readBinding(h).boundPersona.personaPrompt !== ORIGINAL_PROMPT);

    expect(h.runModelPreset).toHaveBeenCalledTimes(1);
    const call = h.runModelPreset.mock.calls[0][0] as PresetCall;
    expect(call.presetId).toBe("preset-1");
    expect(call.chatId).toBe("chat-1");
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("recent_dialogue");
    const payload = JSON.parse(call.messages[1].content);
    expect(payload.current_persona).toEqual({ fixed_name: "Alice", persona_prompt: ORIGINAL_PROMPT });
    expect(payload.target_character).toEqual({ name: "Bram", description: "A gruff innkeeper." });
    expect(payload.recent_dialogue).toHaveLength(6);
    expect(payload.recent_dialogue[0]).toEqual({ speaker: "user", name: "Alice", text: "line 0" });

    const binding = readBinding(h);
    expect(binding.boundPersona.personaPrompt).toBe("Alice is a knight, now limping on a bandaged left leg.");
    expect(binding.boundPersona.name).toBe("Alice");
    expect(binding.autoAdapt.turnsSinceAdapt).toBe(0);
    expect(binding.autoAdapt.lastAdaptedAt).toBeGreaterThan(0);
    expect(binding.updatedAt).toBeGreaterThan(1000);
    // The temp persona the host resolves for {{user}} follows the binding.
    expect(h.db.personas.find((p: any) => p.id === TEMP_PERSONA_ID).personaPrompt).toBe(binding.boundPersona.personaPrompt);
    // The partial window was never rebuilt: the live message array is the original one.
    expect(h.character.chats[0].message).toHaveLength(6);
    expect(h.character.chats[0].messagesFullyLoaded).toBe(false);
    expect(h.setChatToIndex).toHaveBeenCalled();
  });

  test("a second interval reached while a refresh is in flight does not start a second call", async () => {
    let release!: (value: { success: boolean; content: string }) => void;
    const pending = new Promise<{ success: boolean; content: string }>((resolve) => (release = resolve));
    let firstCall: PresetCall | null = null;
    const h = await boot({
      settings: presetSettings,
      runModelPreset: async (call) => {
        firstCall = call;
        return pending;
      },
    });

    for (let i = 0; i < 10; i++) await h.commitReply();
    await until(() => h.runModelPreset.mock.calls.length === 1);

    // Turns 11..20 while the model is still answering: they are counted, and
    // the interval reached at 20 is not a second call.
    for (let i = 0; i < 9; i++) await h.commitReply();
    expect(readBinding(h).autoAdapt.turnsSinceAdapt).toBe(9);
    await h.commitReply();
    await wait(20);
    expect(readBinding(h).autoAdapt.turnsSinceAdapt).toBe(0);
    expect(h.runModelPreset).toHaveBeenCalledTimes(1);

    release({ success: true, content: rewriteAnswer(firstCall!, "Alice is a knight who has sworn off the gauntlets.", ["건틀릿을 벗음"]) });
    await until(() => readBinding(h).boundPersona.personaPrompt !== ORIGINAL_PROMPT);
    await wait(20);
    expect(h.runModelPreset).toHaveBeenCalledTimes(1);
  });

  test("a result that arrives after the user edited the binding is discarded", async () => {
    let release!: (value: { success: boolean; content: string }) => void;
    const pending = new Promise<{ success: boolean; content: string }>((resolve) => (release = resolve));
    let firstCall: PresetCall | null = null;
    const h = await boot({
      settings: presetSettings,
      runModelPreset: async (call) => {
        firstCall = call;
        return pending;
      },
    });

    for (let i = 0; i < 10; i++) await h.commitReply();
    await until(() => h.runModelPreset.mock.calls.length === 1);

    // The user saves an edit in the panel meanwhile: the edit stamp moves.
    const edited = { ...readBinding(h), updatedAt: 5000, boundPersona: { ...readBinding(h).boundPersona, personaPrompt: "Alice, edited by hand." } };
    h.character.chats[0].localLore[0].content = JSON.stringify(edited);

    release({ success: true, content: rewriteAnswer(firstCall!, "Alice from the model.", ["변경"]) });
    await wait(50);
    expect(readBinding(h).boundPersona.personaPrompt).toBe("Alice, edited by hand.");
    expect(readBinding(h).updatedAt).toBe(5000);
  });

  test("on a host without the chat output listener the afterRequest replacer counts the turns", async () => {
    const h = await boot({ settings: presetSettings, withChatListener: false });
    expect(h.replacers.has("afterRequest")).toBe(true);
    expect(h.replacers.has("beforeRequest")).toBe(true);

    // Only main-model replies count; the content passes through unchanged.
    expect(await h.afterRequest("translate")).toBe("reply text");
    expect(readBinding(h).autoAdapt?.turnsSinceAdapt ?? 0).toBe(0);

    for (let i = 0; i < 10; i++) expect(await h.afterRequest()).toBe("reply text");
    await until(() => readBinding(h).boundPersona.personaPrompt !== ORIGINAL_PROMPT);
    expect(h.runModelPreset).toHaveBeenCalledTimes(1);
    expect(readBinding(h).autoAdapt.turnsSinceAdapt).toBe(0);
  });

  test("the plugin's own preset request is not mistaken for a chat turn by beforeRequest", async () => {
    const h = await boot({ settings: presetSettings, withChatListener: false });
    let sawBeforeRequest = false;
    h.runModelPreset.mockImplementation(async (call: PresetCall) => {
      // The host runs the preset as mode "model", so the plugin's own hook sees
      // its own messages; they must pass through untouched and unsynced.
      const before = h.replacers.get("beforeRequest")!;
      const messages = call.messages.map((m) => ({ ...m }));
      const result = await before(messages, "model");
      sawBeforeRequest = true;
      expect(result).toBe(messages);
      return { success: true, content: rewriteAnswer(call, "Alice, refreshed.", ["변경"]) };
    });

    for (let i = 0; i < 10; i++) await h.afterRequest();
    await until(() => readBinding(h).boundPersona.personaPrompt === "Alice, refreshed.");
    expect(sawBeforeRequest).toBe(true);
  });

  test("a stored provider is kept: 'risu' settings keep routing through runLLMModel", async () => {
    const h = await boot({
      settings: { provider: "risu", autoAdaptInterval: 2 },
      runLLMModel: async (arg: any) => ({ type: "success", result: rewriteAnswer({ presetId: "", messages: arg.messages }, "Alice via the translate model.", ["변경"]) }),
    });

    await h.commitReply();
    await h.commitReply();
    await until(() => readBinding(h).boundPersona.personaPrompt === "Alice via the translate model.");
    expect(h.runModelPreset).not.toHaveBeenCalled();
    expect(h.runLLMModel).toHaveBeenCalledTimes(1);
    expect(h.runLLMModel.mock.calls[0][0].mode).toBe("translate");
  });

  test("a model failure is logged and leaves the binding alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = await boot({
        settings: presetSettings,
        runModelPreset: async () => ({ success: false, content: "", error: "선택한 모델 프리셋을 찾을 수 없습니다. 프리셋을 다시 선택해 주세요." }),
      });
      for (let i = 0; i < 10; i++) await h.commitReply();
      await until(() => warn.mock.calls.some((call) => String(call[1]).includes("Automatic persona refresh failed")));
      expect(readBinding(h).boundPersona.personaPrompt).toBe(ORIGINAL_PROMPT);
      expect(String(warn.mock.calls.find((call) => String(call[1]).includes("refresh failed"))![2])).toContain("프리셋을 다시 선택해 주세요");
    } finally {
      warn.mockRestore();
    }
  });

  test("a message the user sends while the result is being written is kept, and the send goes through", async () => {
    // The refresh's write sits behind a model call and a host read. The user
    // hits send in that gap: the UI appends the message to the live chat and
    // the plugin's beforeRequest runs while the write holds the mutation
    // flag. Neither may cost the user anything -- the message stays (host),
    // and the send is waited for, not refused (plugin).
    let release!: (value: { success: boolean; content: string }) => void;
    const pending = new Promise<{ success: boolean; content: string }>((resolve) => (release = resolve));
    let firstCall: PresetCall | null = null;
    const h = await boot({
      settings: presetSettings,
      withChatListener: false,
      runModelPreset: async (call) => {
        firstCall = call;
        return pending;
      },
    });
    // The common case: a short chat whose whole history is resident, where a
    // plugin write is a wholesale replacement.
    const live = h.character.chats[0];
    live.messagesFullyLoaded = true;
    setSqlWindow(live, { before: null, nextBefore: null, total: 6, hasOlder: false, hasNewer: false, nextAfter: null, nextPosition: 6 });

    for (let i = 0; i < 10; i++) await h.afterRequest();
    await until(() => h.runModelPreset.mock.calls.length === 1);

    let sendDuringWrite: Promise<any> | null = null;
    h.setChatToIndex.mockImplementation(async (_characterIndex: number, chatIndex: number, incoming: any) => {
      const writesResult = String(incoming.localLore?.[0]?.content ?? "").includes("sworn off");
      if (writesResult && !sendDuringWrite) {
        h.character.chats[chatIndex].message.push({ role: "user", data: "typed meanwhile", chatId: "m-400" });
        const messages = [{ role: "system", content: "persona block" }, { role: "user", content: "typed meanwhile" }];
        sendDuringWrite = h.replacers.get("beforeRequest")!(messages, "model");
      }
      writePluginChatToSlot(h.character.chats, chatIndex, incoming);
    });

    release({ success: true, content: rewriteAnswer(firstCall!, "Alice is a knight who has sworn off the gauntlets.", ["건틀릿을 벗음"]) });
    await until(() => readBinding(h).boundPersona.personaPrompt !== ORIGINAL_PROMPT);

    expect(h.character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m-394", "m-395", "m-396", "m-397", "m-398", "m-399", "m-400"]);
    expect(h.character.chats[0].message.at(-1).data).toBe("typed meanwhile");
    expect(sendDuringWrite).not.toBeNull();
    await expect(sendDuringWrite).resolves.toHaveLength(2);
  });

  test("auto refresh off: turns are not counted", async () => {
    const h = await boot({ settings: { ...presetSettings, autoAdaptEnabled: false } });
    for (let i = 0; i < 10; i++) await h.commitReply();
    await wait(20);
    expect(h.runModelPreset).not.toHaveBeenCalled();
    expect(readBinding(h).autoAdapt).toBeUndefined();
    expect(h.setChatToIndex).not.toHaveBeenCalled();
  });
});
