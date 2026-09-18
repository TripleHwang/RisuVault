import { beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { loadBuiltInPageFoldPlugin } from "./pagefold";

describe("built-in PageFold provider", () => {
  let builtInPageFoldPlugin: Awaited<ReturnType<typeof loadBuiltInPageFoldPlugin>>;

  beforeAll(async () => {
    builtInPageFoldPlugin = await loadBuiltInPageFoldPlugin();
  });

  test("ships the fixed API v3 provider without persisting it in user data", () => {
    expect(builtInPageFoldPlugin).toMatchObject({
      name: "pagefold",
      displayName: "PageFold (built-in)",
      version: "3.0",
      versionOfPlugin: "0.2.5",
      enabled: true,
      builtIn: true,
    });
    expect(builtInPageFoldPlugin.script).toContain("//@name pagefold");
    expect(builtInPageFoldPlugin.script).toContain("//@version 0.2.5");
    expect(builtInPageFoldPlugin.script).toContain('var PAGEFOLD_VERSION = "0.2.5"');
  });

  test("registers the fixed PageFold provider the host dispatches presets through", () => {
    const script = builtInPageFoldPlugin.script;
    // The host looks the provider up by PAGEFOLD_PROVIDER_NAME; it must exist
    // even when the user has configured zero model profiles.
    expect(script).toContain('const PRESET_ROUTE_PROVIDER_NAME = "PageFold"');
    expect(script).toContain("await api.addProvider(\n      PRESET_ROUTE_PROVIDER_NAME,\n      (args, signal) => runProvider(args, signal, null),");
    expect(script.indexOf("PRESET_ROUTE_PROVIDER_NAME,\n      (args, signal) => runProvider(args, signal, null)"))
      .toBeLessThan(script.indexOf("for (const profile of config.models) {"));
    // A profile that would reuse the reserved name is skipped, never swapped in.
    expect(script).toContain("if (registrationName.trim() === PRESET_ROUTE_PROVIDER_NAME) {");
  });

  test("keeps the per-preset route hook and never persists the route", () => {
    const script = builtInPageFoldPlugin.script;
    expect(script).toContain("function applyPresetRoute(savedConfig, override) {");
    expect(script).toContain("const presetRoute = applyPresetRoute(savedConfig, args?.pagefold_route);");
    expect(script).toContain("const { pagefold_route: _presetRouteArg, ...plainArgs }");
    expect(script).toContain('new Set(["google", "vertex", "openrouter", "llmgateway"])');
    // Vertex routes carry a pre-assembled baseUrl and a short-lived token only.
    expect(script).toContain("if (!vertex.projectId && !vertex.baseUrl)");
    expect(script).toContain("if (route.headers && typeof route.headers === \"object\") Object.assign(headers, route.headers);");
    // The route must stay request-scoped.
    expect(script).not.toMatch(/setItem\([^)]*pagefold_route/);
    expect(script).not.toMatch(/setItem\([^)]*presetRoute/);
    expect(script).not.toMatch(/recordRequestLog\([^)]*pagefold_route/);
  });

  test("migrates the config the 0.1.1 build stored in save-backed pluginStorage", () => {
    const script = builtInPageFoldPlugin.script;
    expect(script).toContain("localValue = await syncedStorage.getItem(CONFIG_KEY);");
    // 0.2.5 derives the single legacy profile from activeProvider when models is absent.
    expect(script).toContain("const source = Array.isArray(inputModels) ? inputModels : [{");
  });

  test("is injected for per-preset dispatch without appearing as a standalone model", () => {
    const source = readFileSync("src/ts/plugins/plugins.svelte.ts", "utf8");
    expect(source).toContain("loadBuiltInPageFoldPlugin");
    expect(source).toContain("!isBuiltInPluginName(p.name)");
    expect(source).toContain("const enabledPlugins = [");
    expect(source).toContain("await loadV3Plugins(pluginV3)");

    const requestSource = readFileSync(
      "src/ts/process/request/request.ts",
      "utf8",
    );
    expect(requestSource).toContain("export async function requestChatData(");
    expect(requestSource).toContain("const usePageFold = preset.usePageFold === true");
    expect(requestSource).toContain("const response = await dispatchPageFoldPreset(");

    const apiSource = readFileSync(
      "src/ts/plugins/apiV3/v3.svelte.ts",
      "utf8",
    );
    expect(apiSource).toContain("trustedBuiltInPlugins.has(pluginName)");
    expect(apiSource).toContain("Object.isFrozen(plugin)");
    expect(apiSource).toContain("removeV3Providers(pluginName)");
    expect(apiSource).toContain("const exposeInModelSelector = !(plugin.builtIn && plugin.name === 'pagefold')");
    expect(apiSource).toContain("pluginV2.builtInProviders.set(providerName, registeredProvider)");

    const uiSource = readFileSync(
      "src/lib/Setting/Pages/Model/ModelPresetSettings.svelte",
      "utf8",
    );
    expect(uiSource).toContain("editingPreset.usePageFold");
    expect(uiSource).toContain("modelPresetPageFoldEnable");
    expect(uiSource).toContain("getPageFoldPresetSupport(editingPreset)");
  });
});

describe("built-in PageFold applyPresetRoute", () => {
  // The bundle runs inside the plugin sandbox, so lift the patched helper out
  // of the script text and run it against a saved config here.
  type Route = { activeProvider: string; route: Record<string, unknown> } | null | undefined;
  let applyPresetRoute: (savedConfig: Record<string, any>, override: unknown) => null | {
    profile: Record<string, any>;
    config: Record<string, any>;
  };

  beforeAll(async () => {
    const { script } = await loadBuiltInPageFoldPlugin();
    const slice = (from: string, to: string) => {
      const start = script.indexOf(from);
      const end = script.indexOf(to, start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return script.slice(start, end);
    };
    const source = [
      slice("function profileConfig(value, profile) {", "    // RisuVault: providers the host"),
      slice("const PRESET_ROUTE_PROVIDERS =", "    function modelRegistrationBase(model) {"),
      "return applyPresetRoute;",
    ].join("\n");
    applyPresetRoute = new Function("normalizeModelParameterOverrides", source)(() => ({}));
  });

  const savedConfig = () => ({
    activeProvider: "google",
    packagingMode: "balanced",
    pdfFontSize: 2,
    requestToast: true,
    requestLogging: false,
    mergeConsecutiveRoles: true,
    models: [],
    google: { apiKey: "saved-google-key", model: "saved-model", baseUrl: "https://saved.example/v1beta", reasoningEffort: "high", serviceTier: "flex", streaming: true, inputPrice: 0.5 },
    vertex: { authMode: "service_account", accessToken: "", serviceAccount: "{}", projectId: "saved-project", location: "us-east5", model: "saved-vertex", reasoningEffort: "auto", serviceTier: "standard", streaming: false, inputPrice: 0.3 },
    openrouter: { apiKey: "saved-or-key", model: "saved/or", baseUrl: "https://openrouter.ai/api/v1", reasoningEffort: "auto", serviceTier: "standard", streaming: true, inputPrice: null },
    llmgateway: { apiKey: "", model: "", baseUrl: "https://api.llmgateway.io/v1", reasoningEffort: "auto", serviceTier: "standard", streaming: false, inputPrice: null },
  });

  test("rejects a missing, malformed or unsupported override", () => {
    expect(applyPresetRoute(savedConfig(), undefined as Route)).toBeNull();
    expect(applyPresetRoute(savedConfig(), null as Route)).toBeNull();
    expect(applyPresetRoute(savedConfig(), "google")).toBeNull();
    expect(applyPresetRoute(savedConfig(), { activeProvider: "vercel", route: { model: "x" } })).toBeNull();
    expect(applyPresetRoute(savedConfig(), { activeProvider: "google", route: "key" })).toBeNull();
  });

  test("overlays the preset credential, model and endpoint onto the route provider only", () => {
    const saved = savedConfig();
    const result = applyPresetRoute(saved, {
      activeProvider: "google",
      route: { apiKey: "preset-key", model: "gemini-preset", baseUrl: "https://preset.example/v1beta", ignored: "x" },
    });
    expect(result).not.toBeNull();
    const { profile, config } = result!;
    expect(config.activeProvider).toBe("google");
    expect(config.google).toMatchObject({
      apiKey: "preset-key",
      model: "gemini-preset",
      baseUrl: "https://preset.example/v1beta",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
    expect(config.google.ignored).toBeUndefined();
    // Global packaging settings still come from the saved config.
    expect(config).toMatchObject({ packagingMode: "balanced", pdfFontSize: 2, requestToast: true, mergeConsecutiveRoles: true });
    expect(profile).toMatchObject({ provider: "google", model: "gemini-preset", parameters: {}, streaming: false });
    expect(config.google.streaming).toBe(false);
    // The saved config is not mutated and the other blocks are untouched.
    expect(saved.google.apiKey).toBe("saved-google-key");
    expect(config.openrouter.apiKey).toBe("saved-or-key");
  });

  test("vertex routes keep the host token and baseUrl and fall back to the saved project/location", () => {
    const result = applyPresetRoute(savedConfig(), {
      activeProvider: "vertex",
      route: {
        authMode: "access_token",
        accessToken: "short-lived",
        model: "gemini-vertex",
        baseUrl: "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models",
        headers: { "X-Vertex-AI-LLM-Request-Type": "shared" },
      },
    });
    expect(result!.config.vertex).toMatchObject({
      authMode: "access_token",
      accessToken: "short-lived",
      model: "gemini-vertex",
      baseUrl: "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models",
      headers: { "X-Vertex-AI-LLM-Request-Type": "shared" },
      projectId: "saved-project",
      location: "us-east5",
    });
  });
});

describe("built-in PageFold under a mock host", () => {
  // Runs the whole bundle against a stub of the API v3 host so the start-up
  // migration and a full preset request can be observed end to end.
  type Store = Map<string, unknown>;
  type Provider = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ success: boolean; content: unknown }>;

  const storage = (store: Store) => ({
    getItem: async (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: async (key: string, value: unknown) => void store.set(key, value),
    removeItem: async (key: string) => void store.delete(key),
  });

  async function boot(saveStore: Store, localStore: Store, fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
    const providers = new Map<string, Provider>();
    const registered = new Promise<void>((resolve) => {
      // The fixed provider is registered last before the profile loop; the
      // bundle logs "initialized" once every registration is done.
      const originalLog = console.log;
      console.log = (...parts: unknown[]) => {
        if (String(parts[0]).includes("initialized")) {
          console.log = originalLog;
          resolve();
        }
      };
    });
    const host = {
      getLocalPluginStorage: async () => storage(localStore),
      pluginStorage: storage(saveStore),
      nativeFetch: fetchImpl,
      registerSetting: async () => {},
      addProvider: async (name: string, provider: Provider) => void providers.set(name, provider),
    };
    const { script } = await loadBuiltInPageFoldPlugin();
    const previous = (globalThis as any).Risuai;
    (globalThis as any).Risuai = host;
    try {
      new Function(script)();
      await registered;
    } finally {
      (globalThis as any).Risuai = previous;
    }
    return providers;
  }

  const legacySaveStore = (): Store => new Map<string, unknown>([
    ["pagefold.config.v1", {
      activeProvider: "google",
      packagingMode: "balanced",
      google: { apiKey: "legacy-key", model: "legacy-model", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
    }],
    ["pagefold.font.noto-sans-cjk-kr.v1", "AAAA"],
    ["pagefold.font.noto-emoji.v1", "BBBB"],
  ]);

  const geminiResponse = (text: string) => async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  test("first start migrates the 0.1.1 config and drops its font cache blobs", async () => {
    const saveStore = legacySaveStore();
    const localStore: Store = new Map();
    const providers = await boot(saveStore, localStore, geminiResponse("ok"));

    expect(providers.has("PageFold")).toBe(true);
    expect(saveStore.has("pagefold.font.noto-sans-cjk-kr.v1")).toBe(false);
    expect(saveStore.has("pagefold.font.noto-emoji.v1")).toBe(false);
    expect((saveStore.get("pagefold.sync-config.v1") as any)?.google?.apiKey).toBe("legacy-key");
    expect((saveStore.get("pagefold.sync-config.v1") as any)?.models?.[0]?.model).toBe("legacy-model");
    // The old slot stays so a rollback to 0.1.1 still finds its settings.
    expect(saveStore.has("pagefold.config.v1")).toBe(true);
    expect(localStore.has("pagefold.config.v1")).toBe(true);
  });

  test("keeps JSON escapes verbatim for structured preset requests", async () => {
    const providers = await boot(legacySaveStore(), new Map(), geminiResponse('{"summary":"a\\nb"}'));
    const provider = providers.get("PageFold");
    expect(provider).toBeDefined();
    const base = {
      prompt_chat: [{ role: "user", content: "hello" }],
      mode: "model",
      max_tokens: 64,
      pagefold_route: { activeProvider: "google", route: { apiKey: "route-key", model: "route-model", baseUrl: "https://generativelanguage.googleapis.com/v1beta" } },
    };

    // Without the flag PageFold turns "\n" escapes into real line breaks,
    // which is right for prose but breaks the host's strict JSON parser.
    const plain = await provider!({ ...base });
    expect(plain.success).toBe(true);
    expect(plain.content).toBe('{"summary":"a\nb"}');

    const structured = await provider!({ ...base, structured_output: true });
    expect(structured.success).toBe(true);
    expect(structured.content).toBe('{"summary":"a\\nb"}');
    expect(() => JSON.parse(structured.content as string)).not.toThrow();
  });
});
