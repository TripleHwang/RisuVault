import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { listPluginModelPresets, runPluginModelPreset, type PluginModelPresetRequest } from "./modelPresetApi";

/**
 * The host-only preset APIs, driven against a fake `requestChatData`. What is
 * pinned is the contract a built-in reads: the binding the request is routed
 * with, the one result shape whatever the model does, and the two refusals
 * that would otherwise be answered silently from the wrong model.
 */

const db = () => ({
  modelPresets: [
    { id: "preset-a", name: "Fast" },
    { id: "preset-b", name: "Careful" },
    { id: "", name: "unsaved" },
  ] as any[],
  nodeOnlyModelModeLock: "none" as const,
});

const messages = [
  { role: "system" as const, content: "You adapt personas." },
  { role: "user" as const, content: "Adapt." },
];

describe("listModelPresets", () => {
  test("answers id and name only, skipping a preset with no id", () => {
    expect(listPluginModelPresets(db())).toEqual([
      { id: "preset-a", name: "Fast" },
      { id: "preset-b", name: "Careful" },
    ]);
    expect(listPluginModelPresets({})).toEqual([]);
  });
});

describe("runModelPreset", () => {
  test("routes the request through the named preset as main and sub, tagged as a plugin request", async () => {
    const request = vi.fn<PluginModelPresetRequest>(async () => ({ type: "success", result: "adapted" }));
    const abort = new AbortController();

    const result = await runPluginModelPreset(
      { presetId: "preset-b", messages, maxTokens: 256, temperature: 0.4, chatId: "chat-9" },
      { db: db(), request, abortSignal: abort.signal },
    );

    expect(result).toEqual({ success: true, content: "adapted" });
    expect(request).toHaveBeenCalledOnce();
    const [arg, mode, signal] = request.mock.calls[0];
    expect(mode).toBe("model");
    expect(signal).toBe(abort.signal);
    expect(arg.formated).toEqual(messages);
    expect(arg.modelBindingTarget).toEqual({
      useModelPreset: true,
      modelBinding: { main: "preset-b", sub: "preset-b", separateAux: false, aux: {} },
    });
    expect(arg).toMatchObject({
      maxTokens: 256,
      temperature: 0.4,
      realChatId: "chat-9",
      logSource: "plugin",
      blockPlugins: true,
      noMultiGen: true,
      useStreaming: false,
    });
    // Never the user's MCP tools: a preset with tool use on would otherwise
    // run the tool loop over the plugin's prompt.
    expect(arg.tools).toEqual([]);
    // Extra keys on a plugin message never reach the request.
    const decorated = [{ role: "user" as const, content: "x", multimodals: [{}] } as any];
    await runPluginModelPreset({ presetId: "preset-a", messages: decorated }, { db: db(), request });
    expect(request.mock.calls[1][0].formated).toEqual([{ role: "user", content: "x" }]);
  });

  test("collects a streamed reply into one string", async () => {
    const stream = new ReadableStream<{ [key: string]: string }>({
      start(controller) {
        controller.enqueue({ "0": "part" });
        controller.enqueue({ "0": "partial re" });
        controller.enqueue({ "0": "partial reply" });
        controller.close();
      },
    });
    const request: PluginModelPresetRequest = async () => ({ type: "streaming", result: stream });

    await expect(runPluginModelPreset({ presetId: "preset-a", messages }, { db: db(), request }))
      .resolves.toEqual({ success: true, content: "partial reply" });
  });

  test("a model failure, a thrown transport error and a multiline answer all come back as a result", async () => {
    const failed: PluginModelPresetRequest = async () => ({ type: "fail", result: "429 too many requests" });
    await expect(runPluginModelPreset({ presetId: "preset-a", messages }, { db: db(), request: failed }))
      .resolves.toEqual({ success: false, content: "", error: "429 too many requests" });

    const thrown: PluginModelPresetRequest = async () => { throw new Error("socket closed"); };
    await expect(runPluginModelPreset({ presetId: "preset-a", messages }, { db: db(), request: thrown }))
      .resolves.toEqual({ success: false, content: "", error: "socket closed" });

    const multiline: PluginModelPresetRequest = async () => ({ type: "multiline", result: [["char", "a"]] });
    const result = await runPluginModelPreset({ presetId: "preset-a", messages }, { db: db(), request: multiline });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("refuses an unknown preset and a legacy-locked database before any request", async () => {
    const request = vi.fn<PluginModelPresetRequest>(async () => ({ type: "success", result: "never" }));

    const unknown = await runPluginModelPreset({ presetId: "preset-zzz", messages }, { db: db(), request });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toMatch(/프리셋/);

    // The regime lock would make `resolveChatModelBinding` take the classic
    // path and answer from the global model as if it were the preset.
    const locked = await runPluginModelPreset(
      { presetId: "preset-a", messages },
      { db: { ...db(), nodeOnlyModelModeLock: "legacy" }, request },
    );
    expect(locked.success).toBe(false);
    expect(locked.error).toMatch(/레거시/);

    const malformed = await runPluginModelPreset(
      { presetId: "preset-a", messages: [{ role: "tool" as any, content: "x" }] },
      { db: db(), request },
    );
    expect(malformed.success).toBe(false);
    expect(malformed.error).toMatch(/메시지/);

    expect(request).not.toHaveBeenCalled();
  });

  test("the host exposes both only to a trusted built-in", () => {
    // `makeRisuaiAPIV3` is not exported, so the gate is pinned at the source:
    // both APIs assert trust first, and the trust set is only fed from the
    // built-in registry for a frozen plugin.
    const source = readFileSync("src/ts/plugins/apiV3/v3.svelte.ts", "utf8");
    expect(source).toMatch(/listModelPresets: async \(\) => \{\s*assertTrustedBuiltIn\('listModelPresets'\)/);
    expect(source).toMatch(/runModelPreset: async \([^)]*\) => \{\s*assertTrustedBuiltIn\('runModelPreset'\)/);
    expect(source).toContain("if (!trustedBuiltInPlugins.has(plugin.name)) {");
    expect(source).toContain("if (plugin.builtIn && BUILT_IN_PLUGIN_NAMES.has(plugin.name) && Object.isFrozen(plugin)) {");
    expect(source).toContain("request: requestChatData,");
  });
});
