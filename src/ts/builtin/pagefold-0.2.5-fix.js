//@name pagefold
//@display-name PageFold
//@api 3.0
//@version 0.2.5
//
// RisuVault build of PageFold 0.2.5. The upstream bundle is unchanged except
// for the blocks marked "RisuVault:" below. RisuVault does not use PageFold's
// per-profile providers; a ModelPreset toggle hands the provider an ephemeral
// route (args.pagefold_route = { activeProvider, route }) that carries the
// preset's credential, model and endpoint for that one request. To keep that
// UX working on the multi-profile 0.2.5 code base this file:
//   1. loadConfig: also reads the config the 0.1.1 build stored in
//      save-backed pluginStorage (upstream 0.2.5 only looks in device-local
//      storage), so existing settings and API keys are migrated, not dropped,
//      and drops the font blobs 0.1.1 cached there (0.2.5 embeds its own).
//   2. applyPresetRoute: turns a route into a synthetic in-memory profile plus
//      per-request config. The route is never written to storage and never
//      reaches the request/response logs.
//   3. vertexAuth/callVertex: accept a pre-assembled route.baseUrl and extra
//      route.headers, because the host resolves the Vertex project/location
//      (and any custom endpoint) itself and only sends a short-lived token.
//   4. runProvider: a valid route bypasses the profile lookup.
//   5. A fixed "PageFold" provider is registered before the per-profile loop so
//      the host's builtInProviders.get("PageFold") exists even with zero
//      profiles. The host hides every provider this built-in registers from
//      the model selector.
(() => {
  // src/core.js
  var PAGEFOLD_ID = "pagefold";
  var PAGEFOLD_VERSION = "0.2.5";
  var CONFIG_KEY = "pagefold.config.v1";
  var SYNC_CONFIG_KEY = "pagefold.sync-config.v1";
  var SYNC_CONFIG_VERSION = 2;
  var STATS_KEY = "pagefold.stats.v1";
  var REQUEST_LOGS_KEY = "pagefold.request-logs.v1";
  // RisuVault: font blobs the 0.1.1 build cached in save-backed storage.
  var LEGACY_FONT_CACHE_KEYS = ["pagefold.font.noto-sans-cjk-kr.v1", "pagefold.font.noto-emoji.v1"];
  var REQUEST_LOG_LIMIT = 20;
  var GEMINI_PDF_TOKENS_PER_PAGE = 280;
  var OPENROUTER_PDF_TOKENS_PER_PAGE = 560;
  var DEFAULT_PDF_FONT_SIZE = 1;
  var MIN_PDF_FONT_SIZE = 0.5;
  var MAX_PDF_FONT_SIZE = 12;
  var PDF_NEWLINE_MARKER_DIRECTIVE = "Inside the PDF text layer, every real line break is serialized as a literal \\n marker. Treat each \\n marker as one line break, and when you respond use real line breaks instead of printing the \\n marker unless you are quoting text that already contains it verbatim.";
  var DEFAULT_CONFIG = Object.freeze({
    activeProvider: "google",
    packagingMode: "maximum",
    mergeConsecutiveRoles: false,
    pdfFontSize: DEFAULT_PDF_FONT_SIZE,
    requestLogging: false,
    requestToast: false,
    models: [],
    google: {
      apiKey: "",
      model: "gemini-3.7-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      inputPrice: 0.75,
      reasoningEffort: "auto",
      serviceTier: "standard",
      streaming: false
    },
    vertex: {
      authMode: "access_token",
      accessToken: "",
      serviceAccount: "",
      projectId: "",
      location: "global",
      model: "gemini-3.7-flash",
      inputPrice: 0.375,
      reasoningEffort: "auto",
      serviceTier: "standard",
      streaming: false
    },
    openrouter: {
      apiKey: "",
      model: "google/gemini-3.5-flash",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoningEffort: "auto",
      serviceTier: "standard",
      streaming: false
    },
    vercel: {
      apiKey: "",
      model: "google/gemini-3.5-flash",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      reasoningEffort: "auto",
      serviceTier: "standard",
      streaming: false
    },
    llmgateway: {
      apiKey: "",
      model: "gemini-3.5-flash",
      baseUrl: "https://api.llmgateway.io/v1",
      reasoningEffort: "auto",
      serviceTier: "standard",
      streaming: false
    }
  });
  var GEMINI_REASONING_EFFORTS = /* @__PURE__ */ new Set(["auto", "minimal", "low", "medium", "high"]);
  var GATEWAY_REASONING_EFFORTS = /* @__PURE__ */ new Set(["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  var PROVIDERS = /* @__PURE__ */ new Set(["google", "vertex", "openrouter", "vercel", "llmgateway"]);
  var MODEL_PARAMETER_RULES = Object.freeze({
    temperature: { min: 0, max: 2 },
    top_p: { min: 0, max: 1 },
    top_k: { min: 1, max: 1e6, integer: true },
    min_p: { min: 0, max: 1 },
    frequency_penalty: { min: -2, max: 2 },
    presence_penalty: { min: -2, max: 2 },
    repetition_penalty: { min: 0, max: 2 },
    max_tokens: { min: 1, max: 1048576, integer: true }
  });
  function normalizeProviderRoute(value) {
    const slugs = String(value || "").split(/[,\s]+/u).map((slug) => slug.trim().toLowerCase()).filter(Boolean);
    return [...new Set(slugs)].join(",");
  }
  function normalizeServiceTier(value, fallback = "standard") {
    const tier = String(value || "").trim().toLowerCase();
    if (["standard", "default", "auto", "on_demand"].includes(tier)) return "standard";
    if (["priority", "fast", "on_demand_priority"].includes(tier)) return "priority";
    if (["flex", "on_demand_flex"].includes(tier)) return "flex";
    return fallback;
  }
  function vertexServiceTierHeaders(value) {
    const serviceTier = normalizeServiceTier(value);
    if (serviceTier === "standard") return {};
    return {
      "X-Vertex-AI-LLM-Request-Type": "shared",
      "X-Vertex-AI-LLM-Shared-Request-Type": serviceTier,
      ...serviceTier === "flex" ? { "X-Server-Timeout": "600" } : {}
    };
  }
  function providerRouteSlugs(value) {
    return String(value || "").split(",").map((slug) => slug.trim()).filter(Boolean);
  }
  function mergeObject(base, value) {
    return { ...base, ...value && typeof value === "object" ? value : {} };
  }
  function normalizePdfFontSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_PDF_FONT_SIZE;
    const clamped = Math.min(MAX_PDF_FONT_SIZE, Math.max(MIN_PDF_FONT_SIZE, numeric));
    return Math.round(clamped * 10) / 10;
  }
  function modelProfileDisplayName(model) {
    const source = String(model || "").split("/").pop() || "Model";
    const labels = {
      gemini: "Gemini",
      flash: "Flash",
      pro: "Pro",
      preview: "Preview",
      latest: "Latest",
      exp: "Experimental",
      lite: "Lite",
      image: "Image"
    };
    const modelName = source.split(/[-_]/u).filter(Boolean).map((part) => labels[part.toLowerCase()] || part).join(" ");
    return `PageFold ${modelName}`;
  }
  function normalizeProfileId(value, index, usedIds) {
    const base = String(value || `model-${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || `model-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return id;
  }
  function normalizeProfileInputPrice(value, fallback) {
    const source = value === void 0 || value === null || value === "" ? fallback : value;
    const numeric = Number(source);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }
  function normalizeModelParameterOverrides(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(Object.entries(MODEL_PARAMETER_RULES).map(([key, rule]) => {
      const raw = source[key];
      if (raw === void 0 || raw === null || raw === "") return [key, null];
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return [key, null];
      const clamped = Math.min(rule.max, Math.max(rule.min, numeric));
      return [key, rule.integer ? Math.round(clamped) : clamped];
    }));
  }
  function applyModelParameterOverrides(args, value) {
    const result = { ...args && typeof args === "object" ? args : {} };
    const overrides = normalizeModelParameterOverrides(value);
    for (const [key, parameterValue] of Object.entries(overrides)) {
      if (parameterValue !== null) result[key] = parameterValue;
    }
    return result;
  }
  function normalizeModelProfiles(inputModels, config) {
    const legacyProvider = PROVIDERS.has(config.activeProvider) ? config.activeProvider : "google";
    const legacyRoute = config[legacyProvider];
    const source = Array.isArray(inputModels) ? inputModels : [{
      id: "default",
      name: modelProfileDisplayName(legacyRoute.model),
      provider: legacyProvider,
      model: legacyRoute.model,
      reasoningEffort: legacyRoute.reasoningEffort,
      serviceTier: legacyRoute.serviceTier,
      streaming: legacyRoute.streaming,
      inputPrice: legacyRoute.inputPrice
    }];
    const usedIds = /* @__PURE__ */ new Set();
    const usedNames = /* @__PURE__ */ new Set();
    return source.filter((profile) => profile && typeof profile === "object").map((profile, index) => {
      const provider = PROVIDERS.has(profile.provider) ? profile.provider : legacyProvider;
      const route = config[provider];
      const reasoningEfforts = ["google", "vertex"].includes(provider) ? GEMINI_REASONING_EFFORTS : GATEWAY_REASONING_EFFORTS;
      const model = String(profile.model || route.model || "").trim();
      const baseName = String(profile.name || "").trim() || modelProfileDisplayName(model);
      let name = baseName;
      let nameSuffix = 2;
      while (usedNames.has(name.toLocaleLowerCase())) {
        name = `${baseName} (${nameSuffix})`;
        nameSuffix += 1;
      }
      usedNames.add(name.toLocaleLowerCase());
      return {
        id: normalizeProfileId(profile.id, index, usedIds),
        name,
        provider,
        model,
        reasoningEffort: reasoningEfforts.has(profile.reasoningEffort) ? profile.reasoningEffort : "auto",
        serviceTier: normalizeServiceTier(profile.serviceTier),
        streaming: profile.streaming === true,
        providerRoute: normalizeProviderRoute(profile.providerRoute),
        inputPrice: normalizeProfileInputPrice(profile.inputPrice, route.inputPrice),
        parameters: normalizeModelParameterOverrides(profile.parameters)
      };
    });
  }
  function normalizeConfig(value) {
    const input = value && typeof value === "object" ? value : {};
    const config = {
      ...DEFAULT_CONFIG,
      ...input,
      google: mergeObject(DEFAULT_CONFIG.google, input.google),
      vertex: mergeObject(DEFAULT_CONFIG.vertex, input.vertex),
      openrouter: mergeObject(DEFAULT_CONFIG.openrouter, input.openrouter),
      vercel: mergeObject(DEFAULT_CONFIG.vercel, input.vercel),
      llmgateway: mergeObject(DEFAULT_CONFIG.llmgateway, input.llmgateway)
    };
    if (!PROVIDERS.has(config.activeProvider)) {
      config.activeProvider = DEFAULT_CONFIG.activeProvider;
    }
    if (!["maximum", "balanced", "marked", "marked_combined"].includes(config.packagingMode)) {
      config.packagingMode = DEFAULT_CONFIG.packagingMode;
    }
    config.mergeConsecutiveRoles = input.mergeConsecutiveRoles === true;
    config.requestLogging = input.requestLogging === true;
    config.requestToast = input.requestToast === true;
    config.pdfFontSize = normalizePdfFontSize(input.pdfFontSize ?? input.developer?.fontSize);
    delete config.developer;
    delete config.density;
    delete config.columns;
    delete config.pageTokens;
    delete config.fontUrl;
    delete config.openrouter.appName;
    delete config.openrouter.appUrl;
    delete config.openrouter.inputPrice;
    delete config.openrouter.pdfEngine;
    for (const provider of ["google", "vertex"]) {
      if (!GEMINI_REASONING_EFFORTS.has(config[provider].reasoningEffort)) {
        config[provider].reasoningEffort = DEFAULT_CONFIG[provider].reasoningEffort;
      }
      config[provider].serviceTier = normalizeServiceTier(config[provider].serviceTier);
    }
    for (const provider of ["openrouter", "vercel", "llmgateway"]) {
      if (!GATEWAY_REASONING_EFFORTS.has(config[provider].reasoningEffort)) {
        config[provider].reasoningEffort = DEFAULT_CONFIG[provider].reasoningEffort;
      }
      config[provider].serviceTier = normalizeServiceTier(config[provider].serviceTier);
    }
    config.models = normalizeModelProfiles(input.models, config);
    return config;
  }
  function createSyncedConfig(value) {
    const config = normalizeConfig(value);
    const routeSettings = (provider) => ({
      model: config[provider].model,
      baseUrl: config[provider].baseUrl,
      inputPrice: config[provider].inputPrice,
      reasoningEffort: config[provider].reasoningEffort,
      serviceTier: config[provider].serviceTier,
      streaming: config[provider].streaming === true
    });
    return {
      version: SYNC_CONFIG_VERSION,
      activeProvider: config.activeProvider,
      packagingMode: config.packagingMode,
      mergeConsecutiveRoles: config.mergeConsecutiveRoles === true,
      pdfFontSize: config.pdfFontSize,
      models: config.models,
      google: {
        ...routeSettings("google"),
        apiKey: config.google.apiKey
      },
      vertex: {
        ...routeSettings("vertex"),
        authMode: config.vertex.authMode,
        accessToken: config.vertex.accessToken,
        serviceAccount: config.vertex.serviceAccount,
        projectId: config.vertex.projectId,
        location: config.vertex.location
      },
      openrouter: {
        ...routeSettings("openrouter"),
        apiKey: config.openrouter.apiKey
      },
      vercel: {
        ...routeSettings("vercel"),
        apiKey: config.vercel.apiKey
      },
      llmgateway: {
        ...routeSettings("llmgateway"),
        apiKey: config.llmgateway.apiKey
      }
    };
  }
  function createLocalConfig(value) {
    const config = normalizeConfig(value);
    return {
      version: 1,
      requestLogging: config.requestLogging === true,
      requestToast: config.requestToast === true
    };
  }
  function mergeStoredConfig(localValue, syncedValue) {
    const local = normalizeConfig(localValue);
    const synced = syncedValue && typeof syncedValue === "object" ? syncedValue : {};
    return normalizeConfig({
      ...synced,
      requestLogging: local.requestLogging === true,
      requestToast: local.requestToast === true,
      google: {
        ...synced.google,
        apiKey: synced.google?.apiKey ?? local.google?.apiKey
      },
      vertex: {
        ...synced.vertex,
        authMode: synced.vertex?.authMode ?? local.vertex?.authMode,
        accessToken: synced.vertex?.accessToken ?? local.vertex?.accessToken,
        serviceAccount: synced.vertex?.serviceAccount ?? local.vertex?.serviceAccount
      },
      openrouter: {
        ...synced.openrouter,
        apiKey: synced.openrouter?.apiKey ?? local.openrouter?.apiKey
      },
      vercel: {
        ...synced.vercel,
        apiKey: synced.vercel?.apiKey ?? local.vercel?.apiKey
      },
      llmgateway: {
        ...synced.llmgateway,
        apiKey: synced.llmgateway?.apiKey ?? local.llmgateway?.apiKey
      }
    });
  }
  function serializeTranscript(promptChat) {
    const messages = Array.isArray(promptChat) ? promptChat : [];
    return messages.map((message, index) => {
      const role = String(message?.role || "user").toUpperCase();
      const content = String(message?.content || "");
      return `===== ${role} ${index + 1} =====
${content}`;
    }).join("\n\n");
  }
  function mergeConsecutiveRoleMessages(messages) {
    const merged = [];
    for (const message of messages) {
      const role = String(message?.role || "user");
      const content = String(message?.content || "");
      const previous = merged.at(-1);
      if ((role === "system" || role === "user") && previous && previous.role === role) {
        previous.content = previous.content ? `${previous.content}

${content}` : content;
        continue;
      }
      merged.push({ role, content });
    }
    return merged;
  }
  function packagePrompt(promptChat, mode = "maximum", options = {}) {
    const source = Array.isArray(promptChat) ? promptChat : [];
    const messages = options.mergeConsecutiveRoles === true ? mergeConsecutiveRoleMessages(source) : source;
    const baselineText = messages.map((message) => String(message?.content || "")).join("\n");
    if (mode === "marked" || mode === "marked_combined") {
      const groups = /* @__PURE__ */ new Map();
      const nextParts = /* @__PURE__ */ new Map();
      const nativeMessages = [];
      const marker = /<pdf(?:\s+name\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*>|<\/pdf\s*>/giu;
      let active = null;
      const appendPdfChunk = (chunk, role, index) => {
        if (!active || !chunk) return;
        const previous = active.chunks.at(-1);
        if (previous?.role === role && previous.index === index) previous.content += chunk;
        else active.chunks.push({ role, index, content: chunk });
      };
      const finishPdfBlock = () => {
        if (!active) return;
        const chunks = active.chunks.filter((chunk) => chunk.content.trim());
        if (chunks.length) {
          if (!groups.has(active.name)) groups.set(active.name, []);
          groups.get(active.name).push(`===== PDF: ${active.name} / PART ${active.part} =====
${chunks.map((chunk) => `===== ${chunk.role.toUpperCase()} ${chunk.index + 1} =====
${chunk.content}`).join("\n\n")}`);
        }
        active = null;
      };
      for (const [index, message] of messages.entries()) {
        const role = String(message?.role || "user").toLowerCase();
        const content = String(message?.content || "");
        let nativeContent = "";
        let cursor = 0;
        for (const match of content.matchAll(marker)) {
          const token = match[0];
          const before = content.slice(cursor, match.index);
          if (active) appendPdfChunk(before, role, index);
          else nativeContent += before;
          const closing = /^<\/pdf\s*>$/iu.test(token);
          if (closing) {
            if (active) finishPdfBlock();
            else nativeContent += token;
          } else if (active) {
            appendPdfChunk(token, role, index);
          } else {
            const name = mode === "marked_combined" ? "root" : String(match[1] ?? match[2] ?? "").trim() || "root";
            const part = (nextParts.get(name) || 0) + 1;
            nextParts.set(name, part);
            const referenceName = name.replace(/[\r\n\[\]]/gu, " ");
            nativeContent += `[Use the attached PDF section headed "===== PDF: ${referenceName} / PART ${part} =====" as context at this position.]`;
            active = { name, part, chunks: [] };
          }
          cursor = match.index + token.length;
        }
        const tail = content.slice(cursor);
        if (active) appendPdfChunk(tail, role, index);
        else nativeContent += tail;
        if (nativeContent.trim()) nativeMessages.push({ role, content: nativeContent });
      }
      if (active) {
        const referenceName = active.name.replace(/[\r\n\[\]]/gu, " ");
        nativeMessages.push({
          role: "user",
          content: `[Unclosed PDF marker ignored: "===== PDF: ${referenceName} / PART ${active.part} =====".]`
        });
      }
      return {
        mode,
        baselineText,
        pdfDocuments: Array.from(groups, ([name, sections]) => ({
          name,
          transcript: sections.join("\n\n")
        })),
        nativeMessages,
        systemText: groups.size ? PDF_NEWLINE_MARKER_DIRECTIVE : "",
        userText: ""
      };
    }
    if (mode === "balanced") {
      const systemText = messages.filter((message) => message?.role === "system").map((message) => String(message?.content || "")).join("\n\n");
      const pdfMessages = messages.filter((message) => message?.role !== "system");
      return {
        mode,
        baselineText,
        pdfTranscript: serializeTranscript(pdfMessages),
        pdfDocuments: [{ name: "context", transcript: serializeTranscript(pdfMessages) }],
        systemText: systemText ? `Use the attached PDF as the ordered conversation context and produce the next ASSISTANT response that follows from the full sequence. ${PDF_NEWLINE_MARKER_DIRECTIVE}

Follow the system instructions below.

${systemText}` : `Use the attached PDF as the ordered conversation context and produce the next ASSISTANT response that follows from the full sequence. ${PDF_NEWLINE_MARKER_DIRECTIVE}`,
        userText: ""
      };
    }
    return {
      mode: "maximum",
      baselineText,
      pdfTranscript: serializeTranscript(messages),
      pdfDocuments: [{ name: "context", transcript: serializeTranscript(messages) }],
      systemText: [
        "The attached PDF contains the complete ordered prompt and conversation transcript.",
        "Interpret every section according to its role, follow all applicable SYSTEM and USER instructions, and produce the next ASSISTANT response that follows from the full sequence.",
        PDF_NEWLINE_MARKER_DIRECTIVE
      ].join(" "),
      userText: ""
    };
  }
  function normalizePdfPayloads(value) {
    const source = Array.isArray(value) ? value : [value];
    return source.map((entry, index) => typeof entry === "string" ? { name: index === 0 ? "context" : `document-${index + 1}`, base64: entry } : { name: String(entry?.name || `document-${index + 1}`), base64: String(entry?.base64 || "") }).filter((entry) => entry.base64);
  }
  function nativeOpenAiMessages(messages) {
    return (messages || []).map((message) => ({
      role: ["assistant", "bot", "model"].includes(message.role) ? "assistant" : message.role === "system" ? "system" : "user",
      content: String(message.content || "")
    })).filter((message) => message.content.trim());
  }
  function estimateTextTokens(text) {
    const value = String(text || "");
    let cjk = 0;
    let other = 0;
    for (const char of value) {
      if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
      else other += 1;
    }
    return Math.ceil(cjk * 1.05 + other / 4);
  }
  function calculateSavings({ baselineTokens, optimizedTokens, inputPrice }) {
    const baseline = Math.max(0, Number(baselineTokens) || 0);
    const optimized = Math.max(0, Number(optimizedTokens) || 0);
    const savedTokens = Math.max(0, baseline - optimized);
    return {
      baselineTokens: baseline,
      optimizedTokens: optimized,
      savedTokens,
      savedUsd: savedTokens / 1e6 * Math.max(0, Number(inputPrice) || 0),
      reductionRate: baseline > 0 ? savedTokens / baseline : 0
    };
  }
  var PROTECTED_RESPONSE_REGION = /(`{3,}[\s\S]*?`{3,}|`{3,}[\s\S]*$|`[^`\n\r]*`)/g;
  function restoreResponseNewlines(value) {
    const source = String(value ?? "");
    if (!source.includes("\\")) return source;
    const segments = [];
    let cursor = 0;
    for (const match of source.matchAll(PROTECTED_RESPONSE_REGION)) {
      if (match.index > cursor) segments.push({ protect: false, text: source.slice(cursor, match.index) });
      segments.push({ protect: true, text: match[0] });
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) segments.push({ protect: false, text: source.slice(cursor) });
    return segments.map((segment) => segment.protect ? segment.text : segment.text.replaceAll(/(?<!\\)\\r\\n/gu, "\n").replaceAll(/(?<!\\)\\n/gu, "\n")).join("");
  }
  function buildGeminiRequest(args, packed, pdfBase64, options = {}) {
    const pdfs = normalizePdfPayloads(pdfBase64);
    const parts = pdfs.map((pdf) => ({ inlineData: { mimeType: "application/pdf", data: pdf.base64 } }));
    if (packed.userText) parts.push({ text: packed.userText });
    const generationConfig = {
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      maxOutputTokens: Math.max(1, Number.isFinite(Number(args.max_tokens)) ? Number(args.max_tokens) : 4096),
      temperature: Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0,
      topP: Number.isFinite(Number(args.top_p)) ? Number(args.top_p) : 0.95,
      topK: Math.max(1, Number.isFinite(Number(args.top_k)) ? Number(args.top_k) : 40)
    };
    if (options.reasoningEffort && options.reasoningEffort !== "auto") {
      generationConfig.thinkingConfig = { thinkingLevel: options.reasoningEffort };
    }
    if (args.response_schema?.schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = args.response_schema.schema;
    }
    const request = { generationConfig };
    if (packed.nativeMessages) {
      const systemText = [
        packed.systemText,
        ...packed.nativeMessages.filter((message) => message.role === "system").map((message) => message.content)
      ].filter(Boolean).join("\n\n");
      if (systemText) request.systemInstruction = { parts: [{ text: systemText }] };
      request.contents = packed.nativeMessages.filter((message) => message.role !== "system").map((message) => ({
        role: ["assistant", "bot", "model"].includes(message.role) ? "model" : "user",
        parts: [{ text: message.content }]
      }));
      if (parts.length) request.contents.push({ role: "user", parts });
      if (!request.contents.length) request.contents.push({ role: "user", parts: [{ text: " " }] });
    } else {
      request.systemInstruction = { parts: [{ text: packed.systemText }] };
      request.contents = [{ role: "user", parts }];
    }
    if (options.store === false) request.store = false;
    const serviceTier = normalizeServiceTier(options.serviceTier, null);
    if (options.includeServiceTier && serviceTier && serviceTier !== "standard") {
      request.serviceTier = serviceTier;
    }
    return request;
  }
  function buildFileChatRequest(args, packed, pdfBase64, model, options = {}) {
    const pdfs = normalizePdfPayloads(pdfBase64);
    const content = [];
    if (packed.userText) content.push({ type: "text", text: packed.userText });
    for (const pdf of pdfs) content.push({
      type: "file",
      file: {
        filename: `document-${pdf.name.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "context"}.pdf`,
        file_data: `data:application/pdf;base64,${pdf.base64}`
      }
    });
    const messages = packed.nativeMessages ? nativeOpenAiMessages(packed.nativeMessages) : [
      { role: "system", content: packed.systemText },
      { role: "user", content }
    ];
    if (packed.nativeMessages && packed.systemText) {
      const firstSystem = messages.find((message) => message.role === "system");
      if (firstSystem) firstSystem.content = `${packed.systemText}

${firstSystem.content}`;
      else messages.unshift({ role: "system", content: packed.systemText });
    }
    if (packed.nativeMessages && content.length) messages.push({ role: "user", content });
    const request = {
      model,
      messages,
      stream: false,
      max_tokens: Math.max(1, Number.isFinite(Number(args.max_tokens)) ? Number(args.max_tokens) : 4096),
      temperature: Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0,
      top_p: Number.isFinite(Number(args.top_p)) ? Number(args.top_p) : 0.95
    };
    const overrides = normalizeModelParameterOverrides(options.parameterOverrides);
    for (const key of ["top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty"]) {
      if (overrides[key] !== null) request[key] = overrides[key];
    }
    if (args.response_schema?.schema) {
      request.response_format = {
        type: "json_schema",
        json_schema: {
          name: args.response_schema.name || "risubard_response",
          strict: args.response_schema.strict !== false,
          schema: args.response_schema.schema
        }
      };
    }
    return request;
  }
  function buildOpenRouterRequest(args, packed, pdfBase64, model, options = {}) {
    const request = buildFileChatRequest(args, packed, pdfBase64, model, options);
    request.stream = options.streaming === true;
    if (request.stream) request.stream_options = { include_usage: true };
    const plugins = [];
    if (normalizePdfPayloads(pdfBase64).length) plugins.push({ id: "file-parser", pdf: { engine: "native" } });
    if (args.response_schema?.schema && options.streaming !== true) {
      plugins.push({ id: "response-healing" });
    }
    if (plugins.length) request.plugins = plugins;
    if (options.reasoningEffort && options.reasoningEffort !== "auto") {
      request.reasoning = { effort: options.reasoningEffort };
    }
    const serviceTier = normalizeServiceTier(options.serviceTier, null);
    if (serviceTier && serviceTier !== "standard") request.service_tier = serviceTier;
    const providerRoute = providerRouteSlugs(options.providerRoute);
    if (providerRoute.length) {
      request.provider = { order: providerRoute, allow_fallbacks: false };
    }
    return request;
  }
  function buildLLMGatewayRequest(args, packed, pdfBase64, model, options = {}) {
    const request = buildFileChatRequest(args, packed, pdfBase64, model, options);
    request.stream = options.streaming === true;
    if (request.stream) request.stream_options = { include_usage: true };
    if (options.reasoningEffort && options.reasoningEffort !== "auto") {
      request.reasoning_effort = options.reasoningEffort;
    }
    const serviceTier = normalizeServiceTier(options.serviceTier, null);
    if (serviceTier && serviceTier !== "standard") request.service_tier = serviceTier;
    const providerRoute = providerRouteSlugs(options.providerRoute);
    if (providerRoute.length) {
      request.provider = { order: providerRoute, only: providerRoute };
    }
    return request;
  }
  function buildVercelGatewayRequest(args, packed, pdfBase64, model, options = {}) {
    const request = buildFileChatRequest(args, packed, pdfBase64, model, options);
    request.stream = options.streaming === true;
    if (request.stream) request.stream_options = { include_usage: true };
    if (options.reasoningEffort && options.reasoningEffort !== "auto") {
      request.reasoning = { effort: options.reasoningEffort };
    }
    const gatewayOptions = {};
    const serviceTier = normalizeServiceTier(options.serviceTier, null);
    if (serviceTier && serviceTier !== "standard") gatewayOptions.serviceTier = serviceTier;
    const providerRoute = providerRouteSlugs(options.providerRoute);
    if (providerRoute.length) {
      gatewayOptions.order = providerRoute;
      gatewayOptions.only = providerRoute;
    }
    if (Object.keys(gatewayOptions).length) request.providerOptions = { gateway: gatewayOptions };
    return request;
  }
  function buildConnectionTestRequest(provider, route = {}) {
    const serviceTier = normalizeServiceTier(route.serviceTier, null);
    if (provider === "google" || provider === "vertex") {
      const request2 = {
        contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0 }
      };
      if (provider === "google") {
        request2.store = false;
        if (serviceTier && serviceTier !== "standard") request2.serviceTier = serviceTier;
      }
      return request2;
    }
    const request = {
      model: String(route.model || ""),
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: false,
      max_tokens: 8,
      temperature: 0
    };
    const providerRoute = providerRouteSlugs(route.providerRoute);
    if (provider === "openrouter") {
      if (serviceTier && serviceTier !== "standard") request.service_tier = serviceTier;
      if (providerRoute.length) request.provider = { order: providerRoute, allow_fallbacks: false };
    } else if (provider === "llmgateway") {
      if (serviceTier && serviceTier !== "standard") request.service_tier = serviceTier;
      if (providerRoute.length) request.provider = { order: providerRoute, only: providerRoute };
    } else if (provider === "vercel") {
      const gatewayOptions = {};
      if (serviceTier && serviceTier !== "standard") gatewayOptions.serviceTier = serviceTier;
      if (providerRoute.length) {
        gatewayOptions.order = providerRoute;
        gatewayOptions.only = providerRoute;
      }
      if (Object.keys(gatewayOptions).length) request.providerOptions = { gateway: gatewayOptions };
    }
    return request;
  }
  function extractGeminiResponse(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    const servedServiceTier = normalizeServiceTier(
      payload?.__pagefoldServiceTier || payload?.usageMetadata?.serviceTier || payload?.usageMetadata?.trafficType,
      null
    );
    return {
      text: parts.filter((part) => part?.thought !== true && typeof part?.text === "string").map((part) => part.text).join(""),
      inputTokens: Number(payload?.usageMetadata?.promptTokenCount) || 0,
      outputTokens: Number(payload?.usageMetadata?.candidatesTokenCount) || 0,
      reasoningTokens: Number(payload?.usageMetadata?.thoughtsTokenCount) || 0,
      servedServiceTier,
      httpStatus: Number(payload?.__pagefoldHttpStatus) || 0
    };
  }
  function extractOpenRouterResponse(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    const servedServiceTier = normalizeServiceTier(
      payload?.service_tier || payload?.used_service_tier || payload?.provider_metadata?.gateway?.serviceTier || payload?.choices?.[0]?.message?.provider_metadata?.gateway?.serviceTier || payload?.choices?.[0]?.delta?.provider_metadata?.gateway?.serviceTier,
      null
    );
    return {
      text: typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join("") : "",
      inputTokens: Number(payload?.usage?.prompt_tokens) || 0,
      outputTokens: Number(payload?.usage?.completion_tokens) || 0,
      reasoningTokens: Number(payload?.usage?.reasoning_tokens) || Number(payload?.usage?.completion_tokens_details?.reasoning_tokens) || 0,
      actualCost: Math.max(0, Number(payload?.usage?.cost) || 0),
      servedServiceTier,
      httpStatus: Number(payload?.__pagefoldHttpStatus) || 0
    };
  }
  function createEmptyStats() {
    return { version: 1, total: {}, daily: {}, routes: {}, recent: [] };
  }
  function outputTokenBreakdown(provider, outputTokens, reasoningTokens) {
    const output = Math.max(0, Number(outputTokens) || 0);
    const reasoning = Math.max(0, Number(reasoningTokens) || 0);
    const reasoningIsSeparate = ["google", "vertex"].includes(String(provider || "").toLowerCase());
    return reasoningIsSeparate ? { response: output, reasoning, total: output + reasoning } : { response: Math.max(0, output - reasoning), reasoning, total: output };
  }
  function addNumbers(target, event) {
    for (const key of [
      "requests",
      "successes",
      "failures",
      "sourceCharacters",
      "pdfPages",
      "baselineTokens",
      "optimizedTokens",
      "savedTokens",
      "savedUsd",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "actualCost",
      "latencyMs"
    ]) {
      target[key] = (Number(target[key]) || 0) + (Number(event[key]) || 0);
    }
    return target;
  }
  function applyStatEvent(value, event) {
    const stats = value && value.version === 1 ? structuredClone(value) : createEmptyStats();
    const normalized = {
      ...event,
      requests: 1,
      successes: event.success ? 1 : 0,
      failures: event.success ? 0 : 1
    };
    const aggregate = event.success ? normalized : {
      ...normalized,
      baselineTokens: 0,
      optimizedTokens: 0,
      savedTokens: 0,
      savedUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      actualCost: 0
    };
    const day = new Date(event.timestamp || Date.now()).toISOString().slice(0, 10);
    const route = `${event.provider || "unknown"}\0${event.model || "unknown"}`;
    stats.total = addNumbers(stats.total || {}, aggregate);
    stats.daily[day] = addNumbers(stats.daily[day] || {}, aggregate);
    stats.routes[route] = addNumbers(stats.routes[route] || {}, aggregate);
    stats.recent = [normalized, ...stats.recent || []].slice(0, 100);
    return stats;
  }
  function normalizeRequestLogs(value) {
    const entries = Array.isArray(value?.entries) ? value.entries.filter((entry) => entry && typeof entry === "object" && entry.id) : [];
    return { version: 1, entries: entries.slice(0, REQUEST_LOG_LIMIT) };
  }
  function appendRequestLog(value, entry) {
    const logs = normalizeRequestLogs(value);
    if (!entry || typeof entry !== "object" || !entry.id) return logs;
    logs.entries = [
      entry,
      ...logs.entries.filter((current) => current.id !== entry.id)
    ].slice(0, REQUEST_LOG_LIMIT);
    return logs;
  }
  function sanitizeLogPayload(value, pdfBytes = 0) {
    const byteCount = Math.max(0, Number(pdfBytes) || 0);
    const placeholder = `[PDF \uB0B4\uC6A9 \uD0ED \uCC38\uC870 \xB7 ${byteCount} bytes]`;
    const visit = (current) => {
      if (typeof current === "string") {
        return /^data:application\/pdf;base64,/iu.test(current) ? placeholder : current;
      }
      if (Array.isArray(current)) return current.map(visit);
      if (!current || typeof current !== "object") return current;
      const mimeType = String(current.mimeType || current.mime_type || "").toLowerCase();
      const result = {};
      for (const [key, item] of Object.entries(current)) {
        if (key.startsWith("__pagefold")) continue;
        if (key === "data" && mimeType === "application/pdf" && typeof item === "string") {
          result[key] = placeholder;
        } else {
          result[key] = visit(item);
        }
      }
      return result;
    };
    return visit(value);
  }
  var SENSITIVE_LOG_KEY = /^(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|service[-_]?account)$/iu;
  function redactSensitiveLogFields(value) {
    const seen = /* @__PURE__ */ new WeakSet();
    const visit = (current) => {
      if (Array.isArray(current)) return current.map(visit);
      if (!current || typeof current !== "object") return current;
      if (seen.has(current)) return "[\uC21C\uD658 \uCC38\uC870 \uC81C\uAC70]";
      seen.add(current);
      const result = {};
      for (const [key, item] of Object.entries(current)) {
        result[key] = SENSITIVE_LOG_KEY.test(key) ? "[\uBBFC\uAC10\uC815\uBCF4 \uC81C\uAC70]" : visit(item);
      }
      return result;
    };
    return visit(value);
  }
  function createRequestLogExport(value, options = {}) {
    const logs = normalizeRequestLogs(value);
    return {
      format: "pagefold-request-logs",
      version: 1,
      pluginVersion: String(options.pluginVersion || PAGEFOLD_VERSION),
      exportedAt: String(options.exportedAt || (/* @__PURE__ */ new Date()).toISOString()),
      count: logs.entries.length,
      logs: redactSensitiveLogFields(logs.entries)
    };
  }

  // src/pdf.js
  var PAGE_WIDTH = 595.28;
  var PAGE_HEIGHT = 841.89;
  var DEFAULT_FONT_SIZE = 1;
  var DEFAULT_MARGIN = 0;
  var GLYPH_WIDTH = 0.5;
  var encoder = new TextEncoder();
  function bytes(value) {
    return encoder.encode(value);
  }
  function concat(chunks) {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  function pdfNumber(value) {
    return Number(value.toFixed(6)).toString();
  }
  function calculatePageGrid(fontSize, margin) {
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      throw new RangeError("fontSize must be a positive finite number");
    }
    if (!Number.isFinite(margin) || margin < 0) {
      throw new RangeError("margin must be a non-negative finite number");
    }
    const columns = Math.floor((PAGE_WIDTH - margin * 2) / (fontSize * GLYPH_WIDTH));
    const rows = Math.floor((PAGE_HEIGHT - margin * 2) / fontSize);
    if (columns < 1 || rows < 1) {
      throw new RangeError("fontSize and margin leave no usable page area");
    }
    return { columns, rows };
  }
  function hex(value) {
    return value.toString(16).toUpperCase().padStart(4, "0");
  }
  function unicodeHex(value) {
    return Array.from(value, (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 65535) return hex(codePoint);
      const supplementary = codePoint - 65536;
      return hex(55296 + (supplementary >> 10)) + hex(56320 + (supplementary & 1023));
    }).join("");
  }
  function wrapText(text, columns) {
    const lines = [];
    for (const hardLine of String(text || "").replaceAll(/\r\n?/g, "\n").split("\n")) {
      const characters = Array.from(hardLine);
      if (characters.length === 0) {
        lines.push("");
        continue;
      }
      for (let index = 0; index < characters.length; index += columns) {
        lines.push(characters.slice(index, index + columns).join(""));
      }
    }
    return lines.map((line) => Array.from(line));
  }
  function escapeTranscriptNewlines(value) {
    return String(value || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n");
  }
  function isRtlCharacter(character) {
    const codePoint = character.codePointAt(0);
    return codePoint >= 1424 && codePoint <= 2303 || codePoint >= 64285 && codePoint <= 65023 || codePoint >= 65136 && codePoint <= 65279 || codePoint >= 67584 && codePoint <= 69631 || codePoint >= 124928 && codePoint <= 126975;
  }
  function visualOrder(line) {
    const clusters = [];
    for (const character of line) {
      if (/\p{Mark}/u.test(character) && clusters.length > 0) clusters.at(-1).push(character);
      else clusters.push([character]);
    }
    const visual = [];
    for (let index = 0; index < clusters.length; ) {
      if (!isRtlCharacter(clusters[index][0])) {
        visual.push(...clusters[index]);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < clusters.length && isRtlCharacter(clusters[end][0])) end += 1;
      for (let cursor = end - 1; cursor >= index; cursor -= 1) visual.push(...clusters[cursor]);
      index = end;
    }
    return visual;
  }
  function createCharacterMap(lines) {
    const characters = /* @__PURE__ */ new Map();
    for (const line of lines) {
      for (const character of line) {
        if (characters.has(character)) continue;
        if (characters.size === 65535) {
          throw new RangeError("A PDF can contain at most 65,535 distinct characters");
        }
        characters.set(character, characters.size + 1);
      }
    }
    return characters;
  }
  function createToUnicodeCMap(characters) {
    const entries = Array.from(characters, ([character, cid]) => `<${hex(cid)}><${unicodeHex(character)}>`);
    const mappings = [];
    for (let index = 0; index < entries.length; index += 100) {
      const chunk = entries.slice(index, index + 100);
      mappings.push(`${chunk.length} beginbfchar
${chunk.join("\n")}
endbfchar`);
    }
    return bytes([
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /PMUnicode-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000><FFFF>",
      "endcodespacerange",
      ...mappings,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end"
    ].join("\n"));
  }
  function createPageContent(lines, characters, fontSize, margin) {
    const commands = [
      "BT",
      `/F0 ${pdfNumber(fontSize)} Tf`,
      `${pdfNumber(fontSize)} TL`,
      `1 0 0 1 ${pdfNumber(margin)} ${pdfNumber(PAGE_HEIGHT - margin - fontSize)} Tm`
    ];
    for (const [index, line] of lines.entries()) {
      const encoded = visualOrder(line).map((character) => hex(characters.get(character))).join("");
      commands.push(`<${encoded}> Tj`);
      if (index < lines.length - 1) commands.push("T*");
    }
    commands.push("ET");
    return bytes(commands.join("\n"));
  }
  async function streamObject(data) {
    const compressed = new Uint8Array(await new Response(
      new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))
    ).arrayBuffer());
    return concat([
      bytes(`<< /Length ${compressed.length} /Filter /FlateDecode >>
stream
`),
      compressed,
      bytes("\nendstream")
    ]);
  }
  function serialize(objects) {
    const chunks = [concat([bytes("%PDF-1.7\n%"), new Uint8Array([255, 255, 255, 255]), bytes("\n")])];
    const offsets = [0];
    let length = chunks[0].length;
    for (const [index, object] of objects.entries()) {
      offsets.push(length);
      const serialized = concat([bytes(`${index + 1} 0 obj
`), object, bytes("\nendobj\n")]);
      chunks.push(serialized);
      length += serialized.length;
    }
    const xrefOffset = length;
    chunks.push(bytes([
      `xref
0 ${objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
      "trailer",
      `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF"
    ].join("\n")));
    return concat(chunks);
  }
  async function generateTranscriptPdf(transcript, options = {}) {
    const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    const margin = options.margin ?? DEFAULT_MARGIN;
    const { columns, rows } = calculatePageGrid(fontSize, margin);
    const lines = wrapText(escapeTranscriptNewlines(transcript), columns);
    const pages = [];
    for (let index = 0; index < lines.length; index += rows) {
      pages.push(lines.slice(index, index + rows));
    }
    const characters = createCharacterMap(lines);
    const firstPageObject = 7;
    const pageIds = pages.map((_, index) => firstPageObject + index * 2);
    const objects = [
      bytes("<< /Type /Catalog /Pages 2 0 R >>"),
      bytes(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F0 3 0 R >> >> >>`),
      bytes("<< /Type /Font /Subtype /Type0 /BaseFont /PMUnicode /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>"),
      bytes("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /PMUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 500 /CIDToGIDMap /Identity >>"),
      bytes("<< /Type /FontDescriptor /FontName /PMUnicode /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 500 >>"),
      await streamObject(createToUnicodeCMap(characters))
    ];
    for (const [index, page] of pages.entries()) {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      objects.push(
        bytes(`<< /Type /Page /Parent 2 0 R /Contents ${contentId} 0 R >>`),
        await streamObject(createPageContent(page, characters, fontSize, margin))
      );
    }
    const pdf = serialize(objects);
    return {
      bytes: pdf,
      base64: base64(pdf),
      pageCount: pages.length,
      sourceCharacters: String(transcript || "").length,
      fontSize,
      lineHeight: fontSize,
      columnCount: 1
    };
  }
  function base64(value) {
    let binary = "";
    const chunkSize = 32768;
    for (let offset = 0; offset < value.length; offset += chunkSize) {
      binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  // src/stream.js
  function abortError(message = "\uC2A4\uD2B8\uB9AC\uBC0D \uC694\uCCAD\uC774 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4.") {
    return new DOMException(message, "AbortError");
  }
  function createSseJsonTextStream(body, options = {}) {
    const extractText = typeof options.extractText === "function" ? options.extractText : () => "";
    const extractError = typeof options.extractError === "function" ? options.extractError : () => null;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = "";
    let dataLines = [];
    let settled = false;
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => {
    });
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) rejectCompletion(error);
      else resolveCompletion(events);
    };
    const consumeEvent = (controller) => {
      if (!dataLines.length) return 0;
      const data = dataLines.join("\n").trim();
      dataLines = [];
      if (!data || data === "[DONE]") return 0;
      let event;
      try {
        event = JSON.parse(data);
      } catch (_error) {
        throw new Error("\uC2A4\uD2B8\uB9AC\uBC0D \uC751\uB2F5 JSON\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      }
      const eventError = extractError(event);
      if (eventError) throw eventError;
      events.push(event);
      const text = String(extractText(event) || "");
      if (!text) return 0;
      controller.enqueue(text);
      return 1;
    };
    const processBuffer = (controller, done = false) => {
      let emitted = 0;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (!line) emitted += consumeEvent(controller);
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        newline = buffer.indexOf("\n");
      }
      if (done) {
        const line = buffer.replace(/\r$/u, "");
        buffer = "";
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        emitted += consumeEvent(controller);
      }
      return emitted;
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const emitted = processBuffer(controller, done);
            if (done) {
              if (!events.length) throw new Error("\uC2A4\uD2B8\uB9AC\uBC0D \uC751\uB2F5\uC5D0 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
              settle();
              controller.close();
              try {
                reader.releaseLock();
              } catch {
              }
              return;
            }
            if (emitted > 0) return;
          }
        } catch (error) {
          settle(error);
          try {
            await reader.cancel(error);
          } catch {
          }
          controller.error(error);
          try {
            reader.releaseLock();
          } catch {
          }
        }
      },
      async cancel(reason) {
        const error = reason instanceof Error ? reason : abortError();
        settle(error);
        try {
          await reader.cancel(reason);
        } finally {
          try {
            reader.releaseLock();
          } catch {
          }
        }
      }
    });
    return { stream, completion };
  }
  function createStreamingNewlineRestorer() {
    let mode = "plain";
    let buffer = "";
    let lastPlainCharacter = "";
    const process = (final = false) => {
      let output = "";
      while (buffer) {
        if (mode === "plain") {
          if (buffer[0] === "`") {
            let run2 = 1;
            while (buffer[run2] === "`") run2 += 1;
            if (!final && run2 === buffer.length) break;
            output += buffer.slice(0, run2);
            buffer = buffer.slice(run2);
            lastPlainCharacter = "";
            if (run2 >= 3) mode = "fence";
            else if (run2 === 1) mode = "inline";
            continue;
          }
          if (buffer[0] === "\\") {
            if (!final && buffer.length < 2) break;
            if (buffer.startsWith("\\n") && lastPlainCharacter !== "\\") {
              output += "\n";
              buffer = buffer.slice(2);
              lastPlainCharacter = "\n";
              continue;
            }
            if (buffer.startsWith("\\r")) {
              if (!final && buffer.length < 4 && "\\r\\n".startsWith(buffer)) break;
              if (buffer.startsWith("\\r\\n") && lastPlainCharacter !== "\\") {
                output += "\n";
                buffer = buffer.slice(4);
                lastPlainCharacter = "\n";
                continue;
              }
            }
          }
          output += buffer[0];
          lastPlainCharacter = buffer[0];
          buffer = buffer.slice(1);
          continue;
        }
        if (buffer[0] !== "`") {
          output += buffer[0];
          buffer = buffer.slice(1);
          continue;
        }
        let run = 1;
        while (buffer[run] === "`") run += 1;
        if (!final && run === buffer.length) break;
        output += buffer.slice(0, run);
        buffer = buffer.slice(run);
        if (mode === "fence" && run >= 3 || mode === "inline" && run >= 1) {
          mode = "plain";
          lastPlainCharacter = "";
        }
      }
      return output;
    };
    return {
      push(value) {
        buffer += String(value ?? "");
        return process(false);
      },
      flush() {
        return process(true);
      }
    };
  }
  function transformResponseTextStream(source, options = {}) {
    const reader = source.getReader();
    const restorer = options.restoreNewlines === true ? createStreamingNewlineRestorer() : null;
    const onChunk = typeof options.onChunk === "function" ? options.onChunk : null;
    return new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const tail = restorer?.flush() || "";
              if (tail) {
                onChunk?.(tail);
                controller.enqueue(tail);
              }
              controller.close();
              try {
                reader.releaseLock();
              } catch {
              }
              return;
            }
            const chunk = restorer ? restorer.push(value) : String(value ?? "");
            if (!chunk) continue;
            onChunk?.(chunk);
            controller.enqueue(chunk);
            return;
          }
        } catch (error) {
          try {
            await reader.cancel(error);
          } catch {
          }
          controller.error(error);
          try {
            reader.releaseLock();
          } catch {
          }
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          try {
            reader.releaseLock();
          } catch {
          }
        }
      }
    });
  }

  // src/toast.js
  var STACK_CLASS = "pagefold-request-toast-stack";
  var CARD_CLASS_PREFIX = "pagefold-request-toast-card-";
  var HORIZONTAL_DISMISS_DISTANCE = 60;
  var UPWARD_DISMISS_DISTANCE = 50;
  var DISMISS_ANIMATION_MS = 180;
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }
  function formatCount(value) {
    return Math.max(0, Number(value) || 0).toLocaleString();
  }
  function formatToastElapsed(value) {
    const milliseconds = Math.max(0, Number(value) || 0);
    return milliseconds >= 6e4 ? `${(milliseconds / 6e4).toFixed(1)}\uBD84` : `${(milliseconds / 1e3).toFixed(1)}\uCD08`;
  }
  function createRequestToastManager(api) {
    const entries = /* @__PURE__ */ new Map();
    let root = null;
    let container = null;
    let stack = null;
    let stackPromise = null;
    let renderQueue = Promise.resolve();
    let ticker = null;
    let unavailable = false;
    let warned = false;
    function enqueue(task) {
      renderQueue = renderQueue.then(task).catch((error) => {
        if (!warned) console.warn("[PageFold] \uC694\uCCAD \uD1A0\uC2A4\uD2B8 \uCC98\uB9AC \uC2E4\uD328", error);
        warned = true;
      });
      return renderQueue;
    }
    async function ensureStack() {
      if (stack) return stack;
      if (unavailable) throw new Error("\uBA54\uC778 DOM\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      if (stackPromise) return stackPromise;
      stackPromise = (async () => {
        root = await api.getRootDocument?.();
        if (!root) {
          unavailable = true;
          throw new Error("\uBA54\uC778 DOM \uC811\uADFC \uAD8C\uD55C\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
        }
        const body = await root.querySelector("body");
        if (!body) throw new Error("\uBA54\uC778 \uD654\uBA74 body\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        container = await root.querySelector(`.${STACK_CLASS}`);
        if (!container) {
          container = await root.createElement("div");
          await container.addClass(STACK_CLASS);
          await container.setInnerHTML('<div style="position:fixed;top:10px;right:10px;z-index:10000;display:flex;flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none"></div>');
          await body.appendChild(container);
        }
        stack = await root.querySelector(`.${STACK_CLASS} > div`);
        if (!stack) throw new Error("\uC694\uCCAD \uD1A0\uC2A4\uD2B8 \uCEE8\uD14C\uC774\uB108\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        return stack;
      })().finally(() => {
        stackPromise = null;
      });
      return stackPromise;
    }
    function startTicker() {
      if (ticker || !entries.size) return;
      ticker = setInterval(() => {
        if (!entries.size) return stopTicker();
        void enqueue(renderAll);
      }, 1e3);
    }
    function stopTicker() {
      if (!ticker) return;
      clearInterval(ticker);
      ticker = null;
    }
    function accentColor(tone) {
      return tone === "success" ? "#22c55e" : tone === "failure" ? "#ef4444" : tone === "aborted" ? "#94a3b8" : "#3b82f6";
    }
    async function setCardGestureStyle(card, transform, opacity, transition = "none") {
      await Promise.all([
        card.setStyle("transform", transform),
        card.setStyle("opacity", String(opacity)),
        card.setStyle("transition", transition)
      ]);
    }
    async function unbindDismissGesture(entry) {
      if (!entry?.card || !entry.gestureListeners?.length) return;
      const listeners = entry.gestureListeners.splice(0);
      await Promise.all(listeners.map(({ type, id }) => entry.card.removeEventListener(type, id).catch(() => {
      })));
    }
    function dismiss(entry, direction) {
      if (!entry || entry.dismissed) return Promise.resolve();
      entry.dismissed = true;
      if (entry.removeTimer) clearTimeout(entry.removeTimer);
      const transform = direction === "up" ? "translate3d(0,-130%,0)" : `translate3d(${direction === "left" ? "-130%" : "130%"},0,0)`;
      const animated = enqueue(async () => {
        await setCardGestureStyle(entry.card, transform, 0, `transform ${DISMISS_ANIMATION_MS}ms ease-out, opacity ${DISMISS_ANIMATION_MS}ms ease-out`);
      });
      entry.dismissTimer = setTimeout(() => remove(entry.id), DISMISS_ANIMATION_MS);
      return animated;
    }
    async function bindDismissGesture(entry) {
      if (!entry.card || entry.gestureListeners?.length) return;
      const gesture = { active: false, startX: 0, startY: 0, dx: 0, dy: 0 };
      const listen = async (type, listener) => {
        const id = await entry.card.addEventListener(type, listener);
        entry.gestureListeners.push({ type, id });
      };
      await Promise.all([
        entry.card.setStyle("pointerEvents", "auto"),
        entry.card.setStyle("touchAction", "none"),
        entry.card.setStyle("userSelect", "none"),
        entry.card.setStyle("cursor", "grab"),
        entry.card.setStyle("willChange", "transform,opacity")
      ]);
      await listen("pointerdown", async (event) => {
        if (entry.dismissed || (Number(event?.button) || 0) !== 0) return;
        const x = Number(event?.clientX);
        const y = Number(event?.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const rect = await entry.card.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        gesture.active = true;
        gesture.startX = x;
        gesture.startY = y;
        gesture.dx = 0;
        gesture.dy = 0;
        await Promise.all([
          entry.card.setStyle("transition", "none"),
          entry.card.setStyle("cursor", "grabbing")
        ]);
      });
      await listen("pointermove", async (event) => {
        if (!gesture.active || entry.dismissed) return;
        gesture.dx = Number(event?.clientX) - gesture.startX;
        gesture.dy = Math.min(0, Number(event?.clientY) - gesture.startY);
        if (!Number.isFinite(gesture.dx) || !Number.isFinite(gesture.dy)) return;
        if (Math.abs(gesture.dx) >= HORIZONTAL_DISMISS_DISTANCE && Math.abs(gesture.dx) >= -gesture.dy) {
          gesture.active = false;
          await dismiss(entry, gesture.dx < 0 ? "left" : "right");
          return;
        }
        if (gesture.dy <= -UPWARD_DISMISS_DISTANCE) {
          gesture.active = false;
          await dismiss(entry, "up");
          return;
        }
        const distance = Math.max(Math.abs(gesture.dx) / 120, -gesture.dy / 100);
        await setCardGestureStyle(
          entry.card,
          `translate3d(${gesture.dx}px,${gesture.dy}px,0)`,
          Math.max(0.25, 1 - distance * 0.7)
        );
      });
      const release = async (event, cancelled = false) => {
        if (!gesture.active || entry.dismissed) return;
        gesture.active = false;
        gesture.dx = Number(event?.clientX) - gesture.startX;
        gesture.dy = Math.min(0, Number(event?.clientY) - gesture.startY);
        await entry.card.setStyle("cursor", "grab");
        if (!cancelled && Math.abs(gesture.dx) >= HORIZONTAL_DISMISS_DISTANCE && Math.abs(gesture.dx) >= -gesture.dy) {
          await dismiss(entry, gesture.dx < 0 ? "left" : "right");
          return;
        }
        if (!cancelled && gesture.dy <= -UPWARD_DISMISS_DISTANCE) {
          await dismiss(entry, "up");
          return;
        }
        await setCardGestureStyle(
          entry.card,
          "translate3d(0,0,0)",
          1,
          "transform 160ms ease-out, opacity 160ms ease-out"
        );
      };
      await listen("pointerup", (event) => release(event));
      await listen("pointercancel", (event) => release(event, true));
      await listen("mouseleave", (event) => release(event, true));
    }
    async function ensureCard(entry) {
      if (entry.card) return entry.card;
      const target = await ensureStack();
      const className = `${CARD_CLASS_PREFIX}${entry.id}`;
      entry.card = await root.querySelector(`.${className}`);
      if (!entry.card) {
        entry.card = await root.createElement("div");
        await entry.card.addClass(className);
        await target.appendChild(entry.card);
      }
      await bindDismissGesture(entry);
      return entry.card;
    }
    async function render(entry) {
      if (!entry || entry.dismissed || !entries.has(entry.id)) return;
      const card = await ensureCard(entry);
      const elapsed = (entry.endedAt || Date.now()) - entry.startedAt;
      const accent = accentColor(entry.tone);
      const detail = entry.detail ? ` \xB7 ${escapeHtml(entry.detail)}` : "";
      const metrics = entry.metrics || {};
      const pdf = Number(metrics.pdfPages) > 0 ? `<div style="margin-top:5px;color:#94a3b8">PDF <span style="color:#e2e8f0;font-weight:650">${formatCount(metrics.pdfPages)}p</span>${Number(metrics.pdfBytes) > 0 ? ` \xB7 ${formatCount(metrics.pdfBytes)} bytes` : ""}</div>` : "";
      const baseline = Math.max(0, Number(metrics.baselineTokens) || 0);
      const optimized = Math.max(0, Number(metrics.optimizedTokens) || 0);
      const delta = optimized - baseline;
      const tokens = baseline > 0 && metrics.failed !== true ? `<div style="margin-top:3px;display:flex;align-items:center;gap:5px;white-space:nowrap"><span style="color:#94a3b8">\uC785\uB825 \uD1A0\uD070</span><span style="color:#64748b;text-decoration:line-through">${formatCount(baseline)}</span><span style="color:#64748b">\u2192</span><strong style="color:#f8fafc">${optimized > 0 ? formatCount(optimized) : "\u2026"}</strong>${optimized > 0 ? `<span style="color:#f87171">(${delta > 0 ? "+" : ""}${delta.toLocaleString()})</span>` : ""}</div>` : metrics.failed === true ? '<div style="margin-top:3px;color:#94a3b8">\uC785\uB825 \uD1A0\uD070 <span style="color:#64748b">\u2014</span></div>' : "";
      const outputs = Number(metrics.outputTokens) > 0 ? `<div style="margin-top:3px;color:#94a3b8">\uCD9C\uB825 \uD1A0\uD070 <span style="color:#e2e8f0">${metrics.outputEstimated === true ? "~" : ""}${formatCount(metrics.outputTokens)}</span>${Number(metrics.outputTokensPerSecond) > 0 ? ` \xB7 <span style="color:#e2e8f0">${Number(metrics.outputTokensPerSecond).toFixed(1)} tokens/s</span>` : ""}</div>` : "";
      await card.setInnerHTML(`<div style="min-width:270px;max-width:380px;border:1px solid #334155;border-left:4px solid ${accent};border-radius:8px;background:rgba(15,23,42,.96);box-shadow:0 10px 30px rgba(0,0,0,.35);padding:10px 12px;color:#e2e8f0;font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"><div style="display:flex;align-items:center;gap:7px"><span style="width:7px;height:7px;border-radius:999px;flex:0 0 auto;background:${accent}"></span><strong style="color:${accent};font-weight:650;white-space:nowrap">${escapeHtml(entry.stage)}</strong><span style="margin-left:auto;flex:0 0 auto;color:#94a3b8;font-variant-numeric:tabular-nums">${formatToastElapsed(elapsed)}</span></div><div style="margin-top:3px;color:#94a3b8;font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(entry.label)}${detail}</div>${pdf}${tokens}${outputs}</div>`);
    }
    async function renderAll() {
      await Promise.all([...entries.values()].map(render));
    }
    function start(id, label, stage = "\uC694\uCCAD \uC2DC\uC791", detail = "", metrics = {}) {
      const key = String(id);
      entries.set(key, {
        id: key,
        label: String(label || "PageFold"),
        stage,
        detail,
        tone: "active",
        startedAt: Date.now(),
        endedAt: 0,
        card: null,
        removeTimer: null,
        dismissTimer: null,
        dismissed: false,
        gestureListeners: [],
        metrics: { ...metrics }
      });
      startTicker();
      return enqueue(() => render(entries.get(key)));
    }
    function update(id, stage, detail = "", metrics = {}) {
      const entry = entries.get(String(id));
      if (!entry || entry.dismissed || entry.endedAt) return Promise.resolve();
      entry.stage = String(stage || entry.stage);
      entry.detail = String(detail || "");
      entry.metrics = { ...entry.metrics, ...metrics };
      return enqueue(() => render(entry));
    }
    function finish(id, stage, detail = "", tone = "success", metrics = {}) {
      const entry = entries.get(String(id));
      if (!entry || entry.dismissed) return Promise.resolve();
      entry.stage = String(stage || entry.stage);
      entry.detail = String(detail || "");
      entry.tone = tone;
      entry.metrics = { ...entry.metrics, ...metrics };
      entry.endedAt = Date.now();
      const rendered = enqueue(() => render(entry));
      entry.removeTimer = setTimeout(() => remove(id), tone === "failure" ? 8e3 : 5e3);
      return rendered;
    }
    function remove(id) {
      const key = String(id);
      const entry = entries.get(key);
      if (!entry) return Promise.resolve();
      entries.delete(key);
      if (entry.removeTimer) clearTimeout(entry.removeTimer);
      if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
      return enqueue(async () => {
        await unbindDismissGesture(entry);
        await entry.card?.remove();
        if (!entries.size) stopTicker();
      });
    }
    async function dispose() {
      stopTicker();
      for (const entry of entries.values()) {
        if (entry.removeTimer) clearTimeout(entry.removeTimer);
        if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
        await unbindDismissGesture(entry);
      }
      entries.clear();
      await renderQueue;
      await container?.remove();
      root = null;
      container = null;
      stack = null;
    }
    return { start, update, finish, remove, dispose };
  }

  // src/index.js
  (async () => {
    const api = globalThis.Risuai ?? globalThis.risuai;
    if (!api) return;
    const supportsLocalPluginStorage = typeof api.getLocalPluginStorage === "function";
    const localStorage = supportsLocalPluginStorage ? await api.getLocalPluginStorage() : api.pluginStorage;
    const syncedStorage = supportsLocalPluginStorage && api.pluginStorage && typeof api.pluginStorage.getItem === "function" && typeof api.pluginStorage.setItem === "function" ? api.pluginStorage : null;
    async function loadConfig() {
      let localValue = await localStorage.getItem(CONFIG_KEY);
      if (!syncedStorage) return normalizeConfig(localValue);
      try {
        let syncedValue = await syncedStorage.getItem(SYNC_CONFIG_KEY);
        // RisuVault: the bundled 0.1.1 build kept its whole config (provider
        // blocks, API keys, packaging mode) in save-backed pluginStorage under
        // CONFIG_KEY, not in device-local storage. Upstream 0.2.5 never reads
        // that slot, so on the first 0.2.5 start feed it into the legacy
        // migration below; normalizeConfig turns activeProvider + its block
        // into the single "default" model profile. The old slot is left in
        // place (harmless, allows rollback) and is ignored once the local
        // config has been written.
        let migrateLegacyBuild = false;
        if (!syncedValue && (localValue === null || localValue === void 0)) {
          localValue = await syncedStorage.getItem(CONFIG_KEY);
          migrateLegacyBuild = true;
        }
        if (!syncedValue || typeof syncedValue !== "object" || syncedValue.version !== SYNC_CONFIG_VERSION) {
          const legacyConfig = syncedValue && typeof syncedValue === "object" ? mergeStoredConfig(localValue, syncedValue) : normalizeConfig(localValue);
          syncedValue = createSyncedConfig(legacyConfig);
          await syncedStorage.setItem(SYNC_CONFIG_KEY, syncedValue);
          await localStorage.setItem(CONFIG_KEY, createLocalConfig(legacyConfig));
          console.info("[PageFold] \uB3D9\uAE30\uD654 \uC124\uC815 \uC800\uC7A5\uC18C\uB85C \uAE30\uC874 \uC124\uC815\uC744 \uC774\uC804\uD588\uC2B5\uB2C8\uB2E4.");
        }
        // RisuVault: the 0.1.1 build also cached the Noto CJK / emoji fonts
        // (tens of MB of base64) in the same save-backed store. 0.2.5 embeds
        // its own PDF font and never reads those keys, so without this they
        // would ride along in every save, backup and account sync forever.
        // Best effort: a failure here must not block the config migration.
        if (migrateLegacyBuild && typeof syncedStorage.removeItem === "function") {
          for (const legacyFontKey of LEGACY_FONT_CACHE_KEYS) {
            try {
              await syncedStorage.removeItem(legacyFontKey);
            } catch (error) {
              console.warn("[PageFold] \uC774\uC804 \uBE4C\uB4DC\uC758 \uAE00\uAF34 \uCE90\uC2DC\uB97C \uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", legacyFontKey, error);
            }
          }
        }
        return mergeStoredConfig(localValue, syncedValue);
      } catch (error) {
        console.warn("[PageFold] \uB3D9\uAE30\uD654 \uC124\uC815\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD574 \uAE30\uAE30 \uB85C\uCEEC \uC124\uC815\uC744 \uC0AC\uC6A9\uD569\uB2C8\uB2E4.", error);
        return normalizeConfig(localValue);
      }
    }
    async function saveConfig(next) {
      const normalized = normalizeConfig(next);
      if (!syncedStorage) {
        await localStorage.setItem(CONFIG_KEY, normalized);
        return normalized;
      }
      try {
        await syncedStorage.setItem(SYNC_CONFIG_KEY, createSyncedConfig(normalized));
        await localStorage.setItem(CONFIG_KEY, createLocalConfig(normalized));
      } catch (error) {
        console.warn("[PageFold] \uC124\uC815 \uB3D9\uAE30\uD654\uC5D0 \uC2E4\uD328\uD574 \uC804\uCCB4 \uC124\uC815\uC744 \uAE30\uAE30 \uB85C\uCEEC\uC5D0 \uC800\uC7A5\uD569\uB2C8\uB2E4.", error);
        await localStorage.setItem(CONFIG_KEY, normalized);
      }
      return normalized;
    }
    let config = await loadConfig();
    let statsWriteQueue = Promise.resolve();
    let requestLogWriteQueue = Promise.resolve();
    let requestSequence = 0;
    let statsPage = 1;
    let vertexTokenCache = null;
    const gatewayPricingCache = /* @__PURE__ */ new Map();
    const pdfCache = /* @__PURE__ */ new Map();
    const requestToast = createRequestToastManager(api);
    if (typeof api.onUnload === "function") {
      await api.onUnload(() => requestToast.dispose());
    }
    const html = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
    const number = (value, digits = 0) => new Intl.NumberFormat(void 0, {
      maximumFractionDigits: digits
    }).format(Number(value) || 0);
    const usd = (value) => new Intl.NumberFormat(void 0, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6
    }).format(Number(value) || 0);
    function routeConfig(value = config) {
      return value[value.activeProvider];
    }
    function profileConfig(value, profile) {
      const provider = profile.provider;
      return {
        ...value,
        activeProvider: provider,
        [provider]: {
          ...value[provider],
          model: profile.model,
          reasoningEffort: profile.reasoningEffort,
          serviceTier: profile.serviceTier,
          streaming: profile.streaming,
          providerRoute: profile.providerRoute,
          inputPrice: profile.inputPrice,
          parameters: profile.parameters
        }
      };
    }
    // RisuVault: providers the host may hand a per-preset route for. "vercel"
    // exists in 0.2.5 but the host has no preset adapter for it yet.
    const PRESET_ROUTE_PROVIDERS = /* @__PURE__ */ new Set(["google", "vertex", "openrouter", "llmgateway"]);
    // RisuVault: must match PAGEFOLD_PROVIDER_NAME in src/ts/builtin/pagefold.ts.
    const PRESET_ROUTE_PROVIDER_NAME = "PageFold";
    // RisuVault: only these route fields are overlaid; everything else on the
    // route object is ignored so a malformed host payload cannot poison the
    // provider block.
    const PRESET_ROUTE_FIELDS = ["apiKey", "accessToken", "authMode", "baseUrl", "headers"];
    // RisuVault: build the per-request config for a host preset route.
    // Returns null when the override is absent or malformed so runProvider
    // falls back to 0.2.5's profile lookup. Global settings (packaging mode,
    // PDF font size, request toast/logging, merge roles) come from the saved
    // config; reasoningEffort/serviceTier/inputPrice come from the saved
    // block of that provider exactly like the 0.1.1 overlay did; the
    // credential, model and endpoint come from the route. Field names match
    // what callGoogle/callVertex/callOpenRouter/callLLMGateway read:
    //   google      apiKey + baseUrl (+ model)
    //   vertex      accessToken + authMode "access_token" + baseUrl (+ headers);
    //               projectId/location are not sent by the host, so they fall
    //               back to the saved vertex block and callVertex prefers the
    //               pre-assembled baseUrl over assembling one from them
    //   openrouter  apiKey + baseUrl (+ model)
    //   llmgateway  apiKey + baseUrl (+ model)
    // The returned objects live only for this request: nothing here is passed
    // to saveConfig, recordStat or recordRequestLog.
    function applyPresetRoute(savedConfig, override) {
      if (!override || typeof override !== "object") return null;
      const provider = override.activeProvider;
      const route = override.route;
      if (!PRESET_ROUTE_PROVIDERS.has(provider)) return null;
      if (!route || typeof route !== "object") return null;
      const base = savedConfig[provider];
      // The host always resolves the preset's wire model id; an empty one is a
      // malformed route, not a request to fall back to whatever profile the
      // user saved in PageFold's own settings.
      const model = String(route.model || "").trim();
      if (!model) return null;
      const profile = {
        id: "risuvault-preset",
        name: "PageFold \uD504\uB9AC\uC14B",
        provider,
        model,
        reasoningEffort: base.reasoningEffort,
        serviceTier: base.serviceTier,
        // Preset requests are collected whole by the host; keep them non-streaming.
        streaming: false,
        providerRoute: "",
        inputPrice: base.inputPrice,
        // Preset sampling values arrive in args already; no profile overrides.
        parameters: normalizeModelParameterOverrides(null)
      };
      const currentConfig = profileConfig(savedConfig, profile);
      const overlay = {};
      for (const key of PRESET_ROUTE_FIELDS) {
        if (route[key] !== void 0 && route[key] !== null) overlay[key] = route[key];
      }
      currentConfig[provider] = { ...currentConfig[provider], ...overlay };
      return { profile, config: currentConfig };
    }
    function modelRegistrationBase(model) {
      const modelName = String(model || "model").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "model";
      return `${PAGEFOLD_ID}-${modelName}`;
    }
    function profileRegistrationName(profile, profiles = config.models) {
      const base = modelRegistrationBase(profile.model);
      const duplicates = profiles.filter((entry) => modelRegistrationBase(entry.model) === base);
      if (duplicates.length === 1) return base;
      const providerDuplicates = duplicates.filter((entry) => entry.provider === profile.provider);
      if (providerDuplicates.length === 1) return `${base}-${profile.provider}`;
      const position = providerDuplicates.findIndex((entry) => entry.id === profile.id) + 1;
      return `${base}-${profile.provider}-${Math.max(1, position)}`;
    }
    function providerRegistrationSignature(models) {
      return JSON.stringify((models || []).map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: profile.model,
        streaming: profile.streaming === true
      })));
    }
    function routeName(provider) {
      return provider === "google" ? "Google AI Studio" : provider === "vertex" ? "Vertex AI" : provider === "openrouter" ? "OpenRouter" : provider === "vercel" ? "Vercel AI Gateway" : provider === "llmgateway" ? "LLM Gateway" : provider;
    }
    function packagingModeName(mode) {
      return mode === "balanced" ? "\uC548\uC815" : mode === "marked" ? "\uB9C8\uCEE4" : mode === "marked_combined" ? "\uB9C8\uCEE4(\uD1B5\uD569)" : "\uC808\uC57D";
    }
    async function persistConfig(next) {
      config = await saveConfig(next);
      pdfCache.clear();
    }
    async function loadStats() {
      const value = await localStorage.getItem(STATS_KEY);
      return value?.version === 1 ? value : createEmptyStats();
    }
    function recordStat(event) {
      statsWriteQueue = statsWriteQueue.then(async () => {
        const current = await loadStats();
        await localStorage.setItem(STATS_KEY, applyStatEvent(current, event));
      }).catch((error) => console.error("PageFold statistics error:", error));
      return statsWriteQueue;
    }
    async function loadRequestLogs() {
      return normalizeRequestLogs(await localStorage.getItem(REQUEST_LOGS_KEY));
    }
    function recordRequestLog(entry) {
      requestLogWriteQueue = requestLogWriteQueue.then(async () => {
        const current = await loadRequestLogs();
        await localStorage.setItem(REQUEST_LOGS_KEY, appendRequestLog(current, entry));
      }).catch((error) => console.error("PageFold request log error:", error));
      return requestLogWriteQueue;
    }
    function simpleHash(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    }
    async function createPdf(document2, currentConfig, signal, log) {
      const fontSize = currentConfig.pdfFontSize ?? DEFAULT_PDF_FONT_SIZE;
      const cacheKey = simpleHash(JSON.stringify({
        transcript: document2.transcript,
        fontSize
      }));
      if (pdfCache.has(cacheKey)) {
        const value2 = pdfCache.get(cacheKey);
        pdfCache.delete(cacheKey);
        pdfCache.set(cacheKey, value2);
        log("PDF \uBA54\uBAA8\uB9AC \uCE90\uC2DC \uC0AC\uC6A9", `${document2.name} / ${value2.pageCount}\uD398\uC774\uC9C0 / ${fontSize}pt`);
        return { ...value2, name: document2.name };
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      log("\uBB34\uD3F0\uD2B8 \uD14D\uC2A4\uD2B8 \uB808\uC774\uC5B4 \uC900\uBE44", `${document2.name} / ${document2.transcript.length}\uC790`);
      log("PDF \uC0DD\uC131 \uC2DC\uC791", `${document2.name} / ${fontSize}pt`);
      const value = await generateTranscriptPdf(
        document2.transcript,
        { fontSize }
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      pdfCache.set(cacheKey, value);
      while (pdfCache.size > 20) pdfCache.delete(pdfCache.keys().next().value);
      return { ...value, name: document2.name };
    }
    async function createPdfs(packed, currentConfig, signal, log) {
      const documents = packed.pdfDocuments || (packed.pdfTranscript ? [{ name: "context", transcript: packed.pdfTranscript }] : []);
      const pdfs = [];
      for (const document2 of documents) {
        pdfs.push(await createPdf(document2, currentConfig, signal, log));
      }
      return pdfs;
    }
    function responseError(message, body, status = 0) {
      const error = new Error(message);
      error.pagefoldResponseBody = body;
      error.pagefoldStatus = status;
      return error;
    }
    async function fetchJson(url, options, signal) {
      let response;
      try {
        response = await api.nativeFetch(url, { ...options, signal });
      } catch (error) {
        if (error && typeof error === "object" && error.name !== "AbortError") {
          error.pagefoldFailureKind = "network";
        }
        throw error;
      }
      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : {};
      } catch (_error) {
      }
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || responseText || `HTTP ${response.status}`;
        throw responseError(message, payload ?? responseText, response.status);
      }
      if (!payload || typeof payload !== "object") {
        throw responseError("JSON \uC751\uB2F5\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", responseText, response.status);
      }
      if (payload.error) {
        throw responseError(payload.error.message || JSON.stringify(payload.error), payload, response.status);
      }
      payload.__pagefoldServiceTier = response.headers?.get?.("x-gemini-service-tier") || null;
      payload.__pagefoldHttpStatus = response.status;
      return payload;
    }
    async function fetchSseText(url, options, signal, streamOptions = {}) {
      let response;
      try {
        response = await api.nativeFetch(url, { ...options, signal });
      } catch (error) {
        if (error && typeof error === "object" && error.name !== "AbortError") {
          error.pagefoldFailureKind = "network";
        }
        throw error;
      }
      if (!response.ok) {
        const responseText = await response.text();
        let payload = null;
        try {
          payload = responseText ? JSON.parse(responseText) : {};
        } catch (_error) {
        }
        throw responseError(
          payload?.error?.message || payload?.message || responseText || `HTTP ${response.status}`,
          payload ?? responseText,
          response.status
        );
      }
      if (!response.body) throw new Error("\uC2A4\uD2B8\uB9AC\uBC0D \uC751\uB2F5 \uBCF8\uBB38\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const handle = createSseJsonTextStream(response.body, {
        extractText: streamOptions.extractText,
        extractError: (event) => event?.error ? responseError(event.error?.message || JSON.stringify(event.error), event, response.status) : null
      });
      const completion = handle.completion.then((events) => {
        events.__pagefoldServiceTier = response.headers?.get?.("x-gemini-service-tier") || null;
        events.__pagefoldHttpStatus = response.status;
        return events;
      });
      void completion.catch(() => {
      });
      return { stream: handle.stream, completion };
    }
    function streamText(content) {
      if (typeof content === "string") return content;
      return Array.isArray(content) ? content.map((part) => part?.text || "").join("") : "";
    }
    function extractGeminiStreamResponse(events) {
      let result = { text: "", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, servedServiceTier: null, httpStatus: 0 };
      for (const event of events) {
        const current = extractGeminiResponse(event);
        result.text += current.text;
        result.inputTokens = current.inputTokens || result.inputTokens;
        result.outputTokens = current.outputTokens || result.outputTokens;
        result.reasoningTokens = current.reasoningTokens || result.reasoningTokens;
        result.servedServiceTier = current.servedServiceTier || result.servedServiceTier;
        result.httpStatus = current.httpStatus || result.httpStatus;
      }
      result.servedServiceTier = normalizeServiceTier(
        events?.__pagefoldServiceTier,
        result.servedServiceTier
      );
      result.httpStatus = Number(events?.__pagefoldHttpStatus) || result.httpStatus;
      return result;
    }
    function extractOpenRouterStreamResponse(events) {
      let result = { text: "", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, actualCost: 0, servedServiceTier: null, httpStatus: 0 };
      for (const event of events) {
        const choice = event?.choices?.[0];
        result.text += streamText(choice?.delta?.content);
        const current = extractOpenRouterResponse(event);
        result.inputTokens = current.inputTokens || result.inputTokens;
        result.outputTokens = current.outputTokens || result.outputTokens;
        result.reasoningTokens = current.reasoningTokens || result.reasoningTokens;
        result.actualCost = current.actualCost || result.actualCost;
        result.servedServiceTier = current.servedServiceTier || result.servedServiceTier;
        result.httpStatus = current.httpStatus || result.httpStatus;
      }
      result.httpStatus = Number(events?.__pagefoldHttpStatus) || result.httpStatus;
      return result;
    }
    function bytesFromBase64(value) {
      const binary = atob(value);
      const bytes2 = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes2[index] = binary.charCodeAt(index);
      return bytes2;
    }
    function base64Url(value) {
      const bytes2 = typeof value === "string" ? new TextEncoder().encode(value) : value;
      let binary = "";
      for (let index = 0; index < bytes2.length; index += 1) binary += String.fromCharCode(bytes2[index]);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    }
    function privateKeyBytes(pem) {
      const body = String(pem || "").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
      if (!body) throw new Error("Vertex \uC11C\uBE44\uC2A4 \uACC4\uC815 private_key\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return bytesFromBase64(body);
    }
    async function serviceAccountToken(vertex, signal) {
      let account;
      try {
        account = JSON.parse(vertex.serviceAccount || "{}");
      } catch (_error) {
        throw new Error("Vertex \uC11C\uBE44\uC2A4 \uACC4\uC815 JSON \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      }
      if (!account.client_email || !account.private_key) {
        throw new Error("Vertex \uC11C\uBE44\uC2A4 \uACC4\uC815 JSON\uC5D0 client_email/private_key\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
      }
      const cacheKey = simpleHash(`${account.client_email}
${account.private_key}`);
      if (vertexTokenCache?.key === cacheKey && vertexTokenCache.expiresAt > Date.now() + 6e4) {
        return { token: vertexTokenCache.token, projectId: vertex.projectId || account.project_id };
      }
      const now = Math.floor(Date.now() / 1e3);
      const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claims = base64Url(JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600
      }));
      const unsigned = `${header}.${claims}`;
      const key = await crypto.subtle.importKey(
        "pkcs8",
        privateKeyBytes(account.private_key),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signature = new Uint8Array(await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(unsigned)
      ));
      const assertion = `${unsigned}.${base64Url(signature)}`;
      const payload = await fetchJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion
        }).toString()
      }, signal);
      if (!payload.access_token) throw new Error("Vertex OAuth access token\uC744 \uBC1B\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      vertexTokenCache = {
        key: cacheKey,
        token: payload.access_token,
        expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1e3
      };
      return { token: payload.access_token, projectId: vertex.projectId || account.project_id };
    }
    async function vertexAuth(vertex, signal) {
      if (vertex.authMode === "service_account") return serviceAccountToken(vertex, signal);
      if (!vertex.accessToken) throw new Error("Vertex AI access token\uC744 \uC124\uC815\uD558\uC138\uC694.");
      // RisuVault: a preset route ships a pre-assembled baseUrl instead of a
      // project ID, so the project is only required when we assemble the URL.
      if (!vertex.projectId && !vertex.baseUrl) throw new Error("Vertex AI project ID\uB97C \uC124\uC815\uD558\uC138\uC694.");
      return { token: vertex.accessToken, projectId: vertex.projectId };
    }
    function captureRequestBody(trace, body, pdfs) {
      if (!trace) return;
      const pdfBytes = (Array.isArray(pdfs) ? pdfs : [pdfs]).reduce((total, pdf) => total + (pdf?.bytes?.byteLength || 0), 0);
      trace.requestBody = sanitizeLogPayload(body, pdfBytes);
    }
    function captureResponseBody(trace, payload, result, streaming) {
      if (!trace) return;
      trace.responseBody = streaming ? sanitizeLogPayload({
        streaming: true,
        eventCount: Array.isArray(payload) ? payload.length : 0,
        assembledResponse: result,
        finalEvent: Array.isArray(payload) ? payload.at(-1) : payload
      }) : sanitizeLogPayload(payload);
    }
    async function openAICompatibleStream(url, requestOptions, signal, inputPricePromise, trace) {
      const handle = await fetchSseText(url, requestOptions, signal, {
        extractText: (event) => streamText(event?.choices?.[0]?.delta?.content)
      });
      const completion = Promise.all([handle.completion, inputPricePromise]).then(([payload, inputPrice]) => {
        const result = { ...extractOpenRouterStreamResponse(payload), inputPrice };
        captureResponseBody(trace, payload, result, true);
        return result;
      });
      void completion.catch(() => {
      });
      return { streaming: true, content: handle.stream, completion };
    }
    async function callGoogle(args, packed, pdfs, currentConfig, signal, trace) {
      const route = currentConfig.google;
      if (!route.apiKey) throw new Error("Google AI Studio API \uD0A4\uB97C \uC124\uC815\uD558\uC138\uC694.");
      if (!route.model) throw new Error("Google AI Studio \uBAA8\uB378\uC744 \uC124\uC815\uD558\uC138\uC694.");
      const body = buildGeminiRequest(args, packed, pdfs, {
        reasoningEffort: route.reasoningEffort,
        serviceTier: route.serviceTier,
        includeServiceTier: true,
        store: false
      });
      captureRequestBody(trace, body, pdfs);
      const streaming = route.streaming === true;
      const url = `${route.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(route.model)}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": route.apiKey
        },
        body: JSON.stringify(body)
      };
      if (streaming) {
        const handle = await fetchSseText(url, requestOptions, signal, {
          extractText: (event) => extractGeminiResponse(event).text
        });
        const completion = handle.completion.then((payload2) => {
          const result2 = extractGeminiStreamResponse(payload2);
          captureResponseBody(trace, payload2, result2, true);
          return { ...result2, servedServiceTier: result2.servedServiceTier || route.serviceTier };
        });
        void completion.catch(() => {
        });
        return { streaming: true, content: handle.stream, completion };
      }
      const payload = await fetchJson(url, requestOptions, signal);
      const result = extractGeminiResponse(payload);
      captureResponseBody(trace, payload, result, false);
      return { ...result, servedServiceTier: result.servedServiceTier || route.serviceTier };
    }
    async function callVertex(args, packed, pdfs, currentConfig, signal, trace) {
      const route = currentConfig.vertex;
      if (!route.model) throw new Error("Vertex AI \uBAA8\uB378\uC744 \uC124\uC815\uD558\uC138\uC694.");
      const auth = await vertexAuth(route, signal);
      const location = route.location || "global";
      if (["flex", "priority"].includes(route.serviceTier) && location !== "global") {
        throw new Error(`Vertex AI ${route.serviceTier === "priority" ? "Priority" : "Flex"}\uB294 Location\uC744 global\uB85C \uC124\uC815\uD574\uC57C \uD569\uB2C8\uB2E4.`);
      }
      const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
      const streaming = route.streaming === true;
      // RisuVault: a preset route carries the ".../publishers/google/models"
      // URL the host already resolved (project, location, custom endpoint);
      // use it verbatim instead of re-assembling from projectId/location.
      const baseUrl = typeof route.baseUrl === "string" && route.baseUrl ? route.baseUrl.replace(/\/$/, "") : `https://${host}/v1/projects/${encodeURIComponent(auth.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models`;
      const url = `${baseUrl}/${encodeURIComponent(route.model)}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`
      };
      Object.assign(headers, vertexServiceTierHeaders(route.serviceTier));
      // RisuVault: the host forwards the preset's request-type header (service
      // tier) on the route; it wins over the saved-block tier headers above.
      if (route.headers && typeof route.headers === "object") Object.assign(headers, route.headers);
      const body = buildGeminiRequest(args, packed, pdfs, {
        reasoningEffort: route.reasoningEffort
      });
      captureRequestBody(trace, body, pdfs);
      const requestOptions = {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      };
      if (streaming) {
        const handle = await fetchSseText(url, requestOptions, signal, {
          extractText: (event) => extractGeminiResponse(event).text
        });
        const completion = handle.completion.then((payload2) => {
          const result2 = extractGeminiStreamResponse(payload2);
          captureResponseBody(trace, payload2, result2, true);
          return { ...result2, servedServiceTier: result2.servedServiceTier || route.serviceTier };
        });
        void completion.catch(() => {
        });
        return { streaming: true, content: handle.stream, completion };
      }
      const payload = await fetchJson(url, requestOptions, signal);
      const result = extractGeminiResponse(payload);
      captureResponseBody(trace, payload, result, false);
      return { ...result, servedServiceTier: result.servedServiceTier || route.serviceTier };
    }
    async function callOpenRouter(args, packed, pdfs, currentConfig, signal, trace) {
      const route = currentConfig.openrouter;
      if (!route.apiKey) throw new Error("OpenRouter API \uD0A4\uB97C \uC124\uC815\uD558\uC138\uC694.");
      if (!route.model) throw new Error("OpenRouter \uBAA8\uB378\uC744 \uC124\uC815\uD558\uC138\uC694.");
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${route.apiKey}`
      };
      const inputPricePromise = gatewayInputPrice("openrouter", route, signal);
      const streaming = route.streaming === true;
      const body = buildOpenRouterRequest(
        args,
        packed,
        pdfs,
        route.model,
        {
          reasoningEffort: route.reasoningEffort,
          serviceTier: route.serviceTier,
          streaming,
          parameterOverrides: route.parameters
        }
      );
      captureRequestBody(trace, body, pdfs);
      const url = `${route.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const requestOptions = {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      };
      if (streaming) return openAICompatibleStream(url, requestOptions, signal, inputPricePromise, trace);
      const payload = await fetchJson(url, requestOptions, signal);
      const result = {
        ...extractOpenRouterResponse(payload),
        inputPrice: await inputPricePromise
      };
      captureResponseBody(trace, payload, result, false);
      return result;
    }
    async function callLLMGateway(args, packed, pdfs, currentConfig, signal, trace) {
      const route = currentConfig.llmgateway;
      if (!route.apiKey) throw new Error("LLM Gateway API \uD0A4\uB97C \uC124\uC815\uD558\uC138\uC694.");
      if (!route.model) throw new Error("LLM Gateway \uBAA8\uB378\uC744 \uC124\uC815\uD558\uC138\uC694.");
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${route.apiKey}`
      };
      const inputPricePromise = gatewayInputPrice("llmgateway", route, signal);
      const streaming = route.streaming === true;
      const body = buildLLMGatewayRequest(
        args,
        packed,
        pdfs,
        route.model,
        {
          reasoningEffort: route.reasoningEffort,
          serviceTier: route.serviceTier,
          streaming,
          parameterOverrides: route.parameters
        }
      );
      captureRequestBody(trace, body, pdfs);
      const url = `${route.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const requestOptions = {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      };
      if (streaming) return openAICompatibleStream(url, requestOptions, signal, inputPricePromise, trace);
      const payload = await fetchJson(url, requestOptions, signal);
      const result = {
        ...extractOpenRouterResponse(payload),
        inputPrice: await inputPricePromise
      };
      captureResponseBody(trace, payload, result, false);
      return result;
    }
    async function callVercelGateway(args, packed, pdfs, currentConfig, signal, trace) {
      const route = currentConfig.vercel;
      if (!route.apiKey) throw new Error("Vercel AI Gateway API \uD0A4\uB97C \uC124\uC815\uD558\uC138\uC694.");
      if (!route.model) throw new Error("Vercel AI Gateway \uBAA8\uB378\uC744 \uC124\uC815\uD558\uC138\uC694.");
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${route.apiKey}`
      };
      const inputPricePromise = gatewayInputPrice("vercel", route, signal);
      const streaming = route.streaming === true;
      const body = buildVercelGatewayRequest(
        args,
        packed,
        pdfs,
        route.model,
        {
          reasoningEffort: route.reasoningEffort,
          serviceTier: route.serviceTier,
          streaming,
          providerRoute: route.providerRoute,
          parameterOverrides: route.parameters
        }
      );
      captureRequestBody(trace, body, pdfs);
      const url = `${route.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const requestOptions = {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      };
      if (streaming) return openAICompatibleStream(url, requestOptions, signal, inputPricePromise, trace);
      const payload = await fetchJson(url, requestOptions, signal);
      const result = {
        ...extractOpenRouterResponse(payload),
        inputPrice: await inputPricePromise
      };
      captureResponseBody(trace, payload, result, false);
      return result;
    }
    async function gatewayInputPrice(provider, route, signal) {
      const cacheKey = `${provider}\0${route.baseUrl}\0${route.model}`;
      if (gatewayPricingCache.has(cacheKey)) return gatewayPricingCache.get(cacheKey);
      try {
        const payload = await fetchJson(`${route.baseUrl.replace(/\/$/, "")}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${route.apiKey}` }
        }, signal);
        const model = Array.isArray(payload.data) ? payload.data.find((entry) => entry?.id === route.model) : null;
        const perMillion = Math.max(0, Number(model?.pricing?.prompt) || 0) * 1e6;
        gatewayPricingCache.set(cacheKey, perMillion);
        return perMillion;
      } catch (_error) {
        return 0;
      }
    }
    async function testProfileConnection(currentConfig, signal) {
      const provider = currentConfig.activeProvider;
      const route = routeConfig(currentConfig);
      if (!route?.model) throw new Error("\uBAA8\uB378 ID\uB97C \uC785\uB825\uD558\uC138\uC694.");
      const body = buildConnectionTestRequest(provider, route);
      if (provider === "google") {
        if (!route.apiKey) throw new Error("Google AI Studio API \uD0A4\uB97C \uC124\uC815\uD558\uC138\uC694.");
        const url = `${route.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(route.model)}:generateContent`;
        await fetchJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": route.apiKey },
          body: JSON.stringify(body)
        }, signal);
        return;
      }
      if (provider === "vertex") {
        const auth = await vertexAuth(route, signal);
        const location = route.location || "global";
        if (["flex", "priority"].includes(route.serviceTier) && location !== "global") {
          throw new Error(`Vertex AI ${route.serviceTier}\uB294 Location\uC744 global\uB85C \uC124\uC815\uD574\uC57C \uD569\uB2C8\uB2E4.`);
        }
        const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
        const url = `https://${host}/v1/projects/${encodeURIComponent(auth.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(route.model)}:generateContent`;
        await fetchJson(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
            ...vertexServiceTierHeaders(route.serviceTier)
          },
          body: JSON.stringify(body)
        }, signal);
        return;
      }
      const providerNames = {
        openrouter: "OpenRouter",
        vercel: "Vercel AI Gateway",
        llmgateway: "LLM Gateway"
      };
      if (!route.apiKey) throw new Error(`${providerNames[provider] || provider} API \uD0A4\uB97C \uC124\uC815\uD558\uC138\uC694.`);
      await fetchJson(`${route.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(body)
      }, signal);
    }
    async function runProvider(args, signal, profileId) {
      const startedAt = Date.now();
      const requestId = ++requestSequence;
      let currentStage = "\uC694\uCCAD \uC2DC\uC791";
      let toastActive = false;
      const log = (stage, detail = "") => {
        currentStage = stage;
        const elapsed = Date.now() - startedAt;
        console.info(`[PageFold #${requestId}] ${stage} (+${elapsed}ms)${detail ? ` \xB7 ${detail}` : ""}`);
        if (toastActive) requestToast.update(requestId, stage, detail);
      };
      log("\uC694\uCCAD \uC2DC\uC791");
      const savedConfig = await loadConfig();
      // RisuVault: a valid host preset route replaces the profile lookup for
      // this request; the fixed "PageFold" provider is called with
      // profileId === null and must never reach a profile.
      const presetRoute = applyPresetRoute(savedConfig, args?.pagefold_route);
      const profile = presetRoute ? presetRoute.profile : profileId === null ? null : savedConfig.models.find((entry) => entry.id === profileId);
      if (!profile) {
        const message = profileId === null ? "\uC774 \uC81C\uACF5\uC790\uB294 \uBAA8\uB378 \uD504\uB9AC\uC14B\uC758 PageFold \uC635\uC158\uC73C\uB85C\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uD504\uB9AC\uC14B \uACBD\uB85C(pagefold_route)\uAC00 \uC5C6\uAC70\uB098 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." : `\uBAA8\uB378 \uD504\uB85C\uD544 '${profileId}'\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD50C\uB7EC\uADF8\uC778\uC744 \uB2E4\uC2DC \uBD88\uB7EC\uC624\uC138\uC694.`;
        console.error(`[PageFold #${requestId}] ${message}`);
        return { success: false, content: `[PageFold] ${message}` };
      }
      const currentConfig = presetRoute ? presetRoute.config : profileConfig(savedConfig, profile);
      // RisuVault: drop the route from the args copy so it can never reach a
      // request builder or the request log; the synthetic profile has no
      // parameter overrides, so preset sampling values pass through as-is.
      const { pagefold_route: _presetRouteArg, ...plainArgs } = args && typeof args === "object" ? args : {};
      const requestArgs = applyModelParameterOverrides(plainArgs, profile.parameters);
      log("\uC124\uC815 \uB85C\uB4DC \uC644\uB8CC", `${profile.name} \xB7 ${currentConfig.activeProvider} / ${routeConfig(currentConfig).model}`);
      const overriddenParameters = Object.entries(profile.parameters || {}).filter(([, value]) => value !== null);
      if (overriddenParameters.length) {
        log("\uBAA8\uB378 \uD30C\uB77C\uBBF8\uD130 \uC7AC\uC815\uC758", overriddenParameters.map(([key, value]) => `${key}=${value}`).join(", "));
      }
      const packed = packagePrompt(requestArgs.prompt_chat, currentConfig.packagingMode, {
        mergeConsecutiveRoles: currentConfig.mergeConsecutiveRoles === true
      });
      log("\uD504\uB86C\uD504\uD2B8 \uD328\uD0A4\uC9D5 \uC644\uB8CC", `${packagingModeName(currentConfig.packagingMode)} / ${packed.baselineText.length}\uC790`);
      const baselineTokens = estimateTextTokens(packed.baselineText);
      const pdfLogContent = (packed.pdfDocuments || (packed.pdfTranscript ? [{ name: "context", transcript: packed.pdfTranscript }] : [])).map((document2) => document2.transcript).join("\n\n");
      let pdfs = [];
      let pdfPages = 0;
      let pdfBytes = 0;
      let result = null;
      let optimizedTokens = 0;
      let predictedTokens = 0;
      let finalized = false;
      const route = routeConfig(currentConfig);
      const requestLogId = currentConfig.requestLogging ? `log-${Date.now().toString(36)}-${requestId.toString(36)}` : null;
      const requestTrace = requestLogId ? {} : null;
      toastActive = currentConfig.requestToast === true;
      if (toastActive) {
        requestToast.start(
          requestId,
          profile.name,
          currentStage,
          `${routeName(currentConfig.activeProvider)} / ${route.model}`,
          { baselineTokens }
        );
      }
      const finalizeSuccess = async (completedResult) => {
        if (finalized) return "";
        if (!completedResult?.text) throw new Error("\uBAA8\uB378 \uC751\uB2F5\uC5D0 \uD14D\uC2A4\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        finalized = true;
        const outputUsage = outputTokenBreakdown(
          currentConfig.activeProvider,
          completedResult.outputTokens,
          completedResult.reasoningTokens
        );
        log("\uD504\uB85C\uBC14\uC774\uB354 \uC751\uB2F5 \uC218\uC2E0", `\uC785\uB825 ${completedResult.inputTokens || predictedTokens} / \uCD9C\uB825 ${outputUsage.total} tokens`);
        if (toastActive) requestToast.update(requestId, currentStage, `${routeName(currentConfig.activeProvider)} / ${route.model}`, {
          optimizedTokens: completedResult.inputTokens || predictedTokens,
          outputTokens: outputUsage.total,
          outputEstimated: false,
          outputTokensPerSecond: 0
        });
        const structuredOutput = requestArgs.structured_output === true || Boolean(requestArgs.response_schema?.schema);
        const responseText = structuredOutput ? completedResult.text : restoreResponseNewlines(completedResult.text);
        if (responseText !== completedResult.text) log("\uC751\uB2F5 \uC904\uBC14\uAFC8 \uB9C8\uCEE4 \uBCF5\uC6D0");
        optimizedTokens = completedResult.inputTokens || predictedTokens;
        const standardInputPrice = Number.isFinite(route.inputPrice) ? route.inputPrice : completedResult.inputPrice;
        const servedServiceTier = normalizeServiceTier(
          completedResult.servedServiceTier || route.serviceTier
        );
        const savings = calculateSavings({
          baselineTokens,
          optimizedTokens,
          inputPrice: standardInputPrice * (servedServiceTier === "flex" ? 0.5 : 1)
        });
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const latencyMs = Date.now() - startedAt;
        if (requestTrace) {
          void recordRequestLog({
            id: requestLogId,
            timestamp,
            provider: currentConfig.activeProvider,
            model: route.model,
            profileName: profile.name,
            success: true,
            statusCode: Number(completedResult.httpStatus) || void 0,
            requestBody: requestTrace.requestBody ?? null,
            pdfContent: escapeTranscriptNewlines(pdfLogContent),
            responseBody: requestTrace.responseBody ?? null,
            pdfPages,
            pdfBytes,
            inputTokens: optimizedTokens,
            outputTokens: completedResult.outputTokens,
            responseTokens: outputUsage.response,
            reasoningTokens: outputUsage.reasoning,
            latencyMs
          });
        }
        void recordStat({
          timestamp,
          ...requestLogId ? { logId: requestLogId } : {},
          provider: currentConfig.activeProvider,
          model: route.model,
          profileId: profile.id,
          profileName: profile.name,
          success: true,
          statusCode: Number(completedResult.httpStatus) || void 0,
          sourceCharacters: packed.baselineText.length,
          pdfPages,
          ...savings,
          inputTokens: completedResult.inputTokens,
          outputTokens: completedResult.outputTokens,
          reasoningTokens: completedResult.reasoningTokens,
          actualCost: completedResult.actualCost,
          reasoningEffort: route.reasoningEffort,
          requestedServiceTier: route.serviceTier,
          servedServiceTier,
          latencyMs
        });
        log("\uD1B5\uACC4 \uAE30\uB85D \uC608\uC57D");
        log("\uC694\uCCAD \uC644\uB8CC");
        if (toastActive) requestToast.finish(
          requestId,
          "\uC644\uB8CC",
          `\uC131\uACF5(${Number(completedResult.httpStatus) || 200})`,
          "success",
          {
            optimizedTokens,
            outputTokens: outputUsage.total,
            outputEstimated: false,
            outputTokensPerSecond: 0
          }
        );
        return responseText;
      };
      const finalizeFailure = async (error) => {
        if (finalized) return signal?.aborted ? "PageFold \uC694\uCCAD\uC774 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : `[PageFold] ${error?.message || String(error)}`;
        finalized = true;
        const aborted = signal?.aborted || error?.name === "AbortError";
        console.error(`[PageFold #${requestId}] \uC2E4\uD328 \xB7 ${currentStage} (+${Date.now() - startedAt}ms)`, error);
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const latencyMs = Date.now() - startedAt;
        const statusCode = Number(error?.pagefoldStatus) || 0;
        const failureKind = aborted ? "aborted" : error?.pagefoldFailureKind || "local";
        if (requestTrace) {
          void recordRequestLog({
            id: requestLogId,
            timestamp,
            provider: currentConfig.activeProvider,
            model: route?.model || "",
            profileName: profile.name,
            success: false,
            ...statusCode ? { statusCode } : {},
            failureKind,
            requestBody: requestTrace.requestBody ?? null,
            pdfContent: escapeTranscriptNewlines(pdfLogContent),
            responseBody: requestTrace.responseBody ?? sanitizeLogPayload(
              error?.pagefoldResponseBody ?? {
                error: {
                  message: error?.message || String(error),
                  ...error?.pagefoldStatus ? { status: error.pagefoldStatus } : {}
                }
              }
            ),
            pdfPages,
            pdfBytes,
            latencyMs
          });
        }
        void recordStat({
          timestamp,
          ...requestLogId ? { logId: requestLogId } : {},
          provider: currentConfig.activeProvider,
          model: route?.model || "",
          profileId: profile.id,
          profileName: profile.name,
          success: false,
          ...statusCode ? { statusCode } : {},
          failureKind,
          sourceCharacters: packed.baselineText.length,
          pdfPages,
          baselineTokens,
          optimizedTokens,
          reasoningEffort: route?.reasoningEffort,
          requestedServiceTier: route?.serviceTier,
          latencyMs
        });
        if (toastActive) requestToast.finish(
          requestId,
          aborted ? "\uC911\uB2E8" : "\uC2E4\uD328",
          statusCode ? `\uC2E4\uD328(${statusCode})` : "",
          aborted ? "aborted" : "failure",
          { failed: true, outputEstimated: false, outputTokensPerSecond: 0 }
        );
        return aborted ? "PageFold \uC694\uCCAD\uC774 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : `[PageFold] ${error?.message || String(error)}`;
      };
      try {
        pdfs = await createPdfs(packed, currentConfig, signal, log);
        pdfPages = pdfs.reduce((total, pdf) => total + pdf.pageCount, 0);
        pdfBytes = pdfs.reduce((total, pdf) => total + pdf.bytes.byteLength, 0);
        log("PDF \uC900\uBE44 \uC644\uB8CC", pdfs.length ? `${pdfs.length}\uAC1C / ${pdfPages}\uD398\uC774\uC9C0 / ${pdfBytes} bytes` : "\uB9C8\uCEE4 PDF \uC5C6\uC74C");
        const pdfTokensPerPage = ["openrouter", "vercel", "llmgateway"].includes(currentConfig.activeProvider) && !(currentConfig.activeProvider === "vercel" && route.model.toLowerCase().startsWith("google/")) ? OPENROUTER_PDF_TOKENS_PER_PAGE : GEMINI_PDF_TOKENS_PER_PAGE;
        const nativeText = packed.nativeMessages ? packed.nativeMessages.map((message) => message.content).join("\n") : `${packed.systemText}
${packed.userText}`;
        predictedTokens = pdfPages * pdfTokensPerPage + estimateTextTokens(nativeText);
        if (toastActive) requestToast.update(requestId, currentStage, `${pdfPages}\uD398\uC774\uC9C0`, {
          pdfPages,
          pdfBytes,
          optimizedTokens: predictedTokens
        });
        log("\uD504\uB85C\uBC14\uC774\uB354 \uC694\uCCAD \uC804\uC1A1", `${currentConfig.activeProvider} / ${route.model}`);
        const providerCalls = {
          google: callGoogle,
          vertex: callVertex,
          openrouter: callOpenRouter,
          vercel: callVercelGateway,
          llmgateway: callLLMGateway
        };
        result = await providerCalls[currentConfig.activeProvider](
          requestArgs,
          packed,
          pdfs,
          currentConfig,
          signal,
          requestTrace
        );
        if (result?.streaming === true) {
          const structuredOutput = requestArgs.structured_output === true || Boolean(requestArgs.response_schema?.schema);
          let streamedText = "";
          let lastToastUpdate = 0;
          const tokenSamples = [];
          const onChunk = (chunk) => {
            streamedText += chunk;
            if (!toastActive) return;
            const now = Date.now();
            const chunkTokens = estimateTextTokens(chunk);
            tokenSamples.push({ at: now, tokens: chunkTokens });
            while (tokenSamples.length && tokenSamples[0].at < now - 3e3) tokenSamples.shift();
            if (now - lastToastUpdate < 200) return;
            lastToastUpdate = now;
            const sampleTokens = tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0);
            const sampleDuration = tokenSamples.length ? Math.max(1e3, now - tokenSamples[0].at) : 1e3;
            requestToast.update(requestId, "\uC751\uB2F5 \uC2A4\uD2B8\uB9AC\uBC0D", `${routeName(currentConfig.activeProvider)} / ${route.model}`, {
              outputTokens: estimateTextTokens(streamedText),
              outputEstimated: true,
              outputTokensPerSecond: sampleTokens / (sampleDuration / 1e3)
            });
          };
          const responseStream = transformResponseTextStream(result.content, {
            restoreNewlines: !structuredOutput,
            onChunk
          });
          log("\uC751\uB2F5 \uC2A4\uD2B8\uB9AC\uBC0D \uC2DC\uC791", `${routeName(currentConfig.activeProvider)} / ${route.model}`);
          void result.completion.then((completedResult) => finalizeSuccess(completedResult)).catch((error) => finalizeFailure(error));
          return { success: true, content: responseStream };
        }
        return { success: true, content: await finalizeSuccess(result) };
      } catch (error) {
        return { success: false, content: await finalizeFailure(error) };
      }
    }
    function ensureStyles() {
      if (document.getElementById("pagefold-style")) return;
      const style = document.createElement("style");
      style.id = "pagefold-style";
      style.textContent = `
      *{box-sizing:border-box} body{margin:0;background:#0b1120;color:#e5e7eb;font:14px/1.5 Inter,system-ui,sans-serif}
      button,input,select,textarea{font:inherit}.pf-app{min-height:100vh;background:linear-gradient(145deg,#0b1120,#111827 60%,#172554)}
      .pf-shell{max-width:1080px;margin:0 auto;padding:24px}.pf-header{display:flex;align-items:center;justify-content:space-between;gap:16px}
      .pf-title{margin:0;font-size:26px}.pf-close,.pf-button{border:1px solid #334155;border-radius:8px;background:#1e293b;color:#e2e8f0;padding:9px 14px;cursor:pointer}.pf-button:disabled{cursor:default;opacity:.45}
      .pf-button.primary{border-color:#2563eb;background:#2563eb;color:white}.pf-button.danger{border-color:#7f1d1d;background:#7f1d1d}.pf-close{font-size:20px;line-height:1}
      .pf-tabs{display:flex;gap:6px;margin:22px 0}.pf-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:#94a3b8;padding:10px 14px;cursor:pointer}
      .pf-tab.active{border-color:#60a5fa;color:#fff}.pf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:14px}.pf-card{border:1px solid #273449;border-radius:12px;background:rgba(15,23,42,.88);padding:18px}
      .pf-card.full{grid-column:1/-1}.pf-card h2{margin:0 0 14px;font-size:15px}.pf-field{display:grid;align-content:start;align-self:start;gap:6px;margin:12px 0}.pf-field label{color:#cbd5e1;font-size:12px;font-weight:650}
      .pf-input{width:100%;min-height:40px;border:1px solid #334155;border-radius:8px;outline:0;background:#0f172a;color:#f8fafc;padding:9px 10px}.pf-input:focus{border-color:#60a5fa}.pf-help{margin:6px 0 0;color:#94a3b8;font-size:12px}
      .pf-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.pf-message{margin-bottom:14px;border:1px solid #1d4ed8;border-radius:8px;background:#172554;padding:10px 12px;color:#bfdbfe}.pf-message.warning{border-color:#d97706;background:#451a03;color:#fde68a}
      .pf-stats-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.pf-stats-toolbar h2{margin:0;font-size:15px}.pf-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}.pf-stat{border:1px solid #273449;border-radius:10px;background:#0f172a;padding:15px}.pf-stat span{display:block;color:#94a3b8;font-size:11px}.pf-stat strong{display:block;margin-top:5px;font-size:20px}
      .pf-stats-actions{display:flex;align-items:center;gap:10px}.pf-log-switch{display:flex;align-items:center;gap:7px;border:1px solid #334155;border-radius:8px;background:#0f172a;padding:7px 10px;color:#cbd5e1;font-size:12px;cursor:pointer}.pf-log-switch input{accent-color:#3b82f6}.pf-log-switch small{color:#64748b}
      .pf-table-wrap{overflow:auto}.pf-table{width:100%;border-collapse:collapse}.pf-table th,.pf-table td{border-bottom:1px solid #273449;padding:9px 8px;text-align:left;white-space:nowrap}.pf-table th{color:#94a3b8;font-size:11px}.pf-empty{padding:28px;text-align:center;color:#94a3b8}
      .pf-token-flow{display:inline-flex;align-items:center;gap:6px}.pf-token-baseline{color:#64748b;text-decoration:line-through}.pf-token-arrow{color:#64748b}.pf-token-optimized{color:#f8fafc;font-weight:650}.pf-token-delta{color:#f87171}
      .pf-stat-unavailable{color:#64748b}.pf-status.success{color:#86efac}.pf-status.failure{color:#f87171}.pf-status.aborted{color:#94a3b8}
      .pf-log-row{cursor:pointer}.pf-log-row:hover td,.pf-log-row:focus td{background:#172033}.pf-log-row:focus{outline:0}
      .pf-pagination{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px}.pf-pagination .pf-button{padding:7px 11px}.pf-pagination .pf-button:disabled{cursor:default;opacity:.45}.pf-page-info{min-width:110px;text-align:center;color:#94a3b8;font-size:12px}
      .pf-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.78);padding:20px}.pf-log-dialog{display:flex;max-height:min(88vh,900px);width:min(1050px,100%);flex-direction:column;border:1px solid #334155;border-radius:12px;background:#0b1220;box-shadow:0 24px 70px rgba(0,0,0,.45)}.pf-log-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;border-bottom:1px solid #273449;padding:16px 18px}.pf-log-header h2{margin:0;font-size:16px}.pf-log-meta{margin-top:4px;color:#94a3b8;font-size:12px}.pf-log-close{border:0;background:transparent;color:#94a3b8;font-size:24px;line-height:1;cursor:pointer}.pf-log-tabs{display:flex;gap:4px;border-bottom:1px solid #273449;padding:10px 14px 0}.pf-log-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:#94a3b8;padding:9px 12px;cursor:pointer}.pf-log-tab.active{border-bottom-color:#60a5fa;color:#f8fafc}.pf-log-content{min-height:0;overflow:hidden;padding:14px}.pf-log-panel{height:min(65vh,680px);overflow:auto}.pf-log-panel[hidden]{display:none}.pf-log-panel-info{margin:0 0 10px;color:#94a3b8;font-size:12px}.pf-log-panel pre{box-sizing:border-box;min-height:100%;margin:0;border:1px solid #273449;border-radius:8px;background:#020617;padding:14px;color:#dbeafe;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .pf-provider{border-left:3px solid #334155}
      .pf-model-list{display:grid;gap:12px;margin-top:14px}.pf-model-profile{border:1px solid #334155;border-radius:10px;background:#0f172a;padding:14px}.pf-model-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.pf-model-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf-model-header .pf-button{padding:6px 10px}.pf-model-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.pf-model-footer .pf-check{margin:10px 0}.pf-connection{display:flex;align-items:center;gap:10px}.pf-connection-result{color:#94a3b8;font-size:12px}.pf-connection-result.success{color:#86efac}.pf-connection-result.failure{color:#fca5a5}.pf-advanced{margin:12px 0;border:1px solid #273449;border-radius:9px;background:#0b1220}.pf-advanced summary{cursor:pointer;padding:10px 12px;color:#cbd5e1;font-size:12px;font-weight:650;user-select:none}.pf-advanced[open] summary{border-bottom:1px solid #273449}.pf-advanced-body{padding:4px 12px 10px}.pf-advanced-body>.pf-help{margin:8px 0 2px}
      .pf-check{display:flex;align-items:flex-start;gap:10px;margin:14px 0}.pf-check input{width:18px;height:18px;margin:2px 0 0;accent-color:#2563eb}.pf-check label{cursor:pointer}.pf-check strong{display:block;color:#e2e8f0;font-size:13px}.pf-check span{display:block;margin-top:3px;color:#94a3b8;font-size:12px}
      @media(max-width:760px){.pf-shell{padding:15px}.pf-grid{grid-template-columns:1fr}.pf-card.full{grid-column:auto}.pf-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pf-header{align-items:flex-start}.pf-title{font-size:22px}.pf-stats-toolbar{align-items:flex-start;flex-direction:column}.pf-stats-actions{width:100%;flex-wrap:wrap}.pf-modal{padding:8px}.pf-log-dialog{max-height:95vh}.pf-log-panel{height:68vh}}
    `;
      document.head.appendChild(style);
    }
    function field(id, label, value, options = {}) {
      const type = options.type || "text";
      if (type === "textarea") {
        return `<div class="pf-field"><label for="${id}">${label}</label><textarea id="${id}" class="pf-input" rows="5" placeholder="${html(options.placeholder || "")}">${html(value)}</textarea>${options.help ? `<p class="pf-help">${options.help}</p>` : ""}</div>`;
      }
      return `<div class="pf-field"><label for="${id}">${label}</label><input id="${id}" class="pf-input" type="${type}" value="${html(value)}" ${options.step ? `step="${options.step}"` : ""} ${options.min !== void 0 ? `min="${options.min}"` : ""} ${options.max !== void 0 ? `max="${options.max}"` : ""} placeholder="${html(options.placeholder || "")}">${options.help ? `<p class="pf-help">${options.help}</p>` : ""}</div>`;
    }
    function checkboxField(id, label, checked, help = "") {
      return `<div class="pf-check"><input id="${id}" type="checkbox" ${checked ? "checked" : ""}><label for="${id}"><strong>${label}</strong>${help ? `<span>${help}</span>` : ""}</label></div>`;
    }
    function selectField(id, label, value, choices, help = "") {
      return `<div class="pf-field"><label for="${id}">${label}</label><select id="${id}" class="pf-input">${choices.map(([optionValue, optionLabel]) => `<option value="${html(optionValue)}" ${value === optionValue ? "selected" : ""}>${html(optionLabel)}</option>`).join("")}</select>${help ? `<p class="pf-help">${help}</p>` : ""}</div>`;
    }
    const geminiReasoningChoices = [
      ["auto", "\uC790\uB3D9"],
      ["minimal", "\uCD5C\uC18C"],
      ["low", "\uB0AE\uC74C"],
      ["medium", "\uC911\uAC04"],
      ["high", "\uB192\uC74C"]
    ];
    const gatewayReasoningChoices = [
      ["auto", "\uC790\uB3D9"],
      ["none", "\uC5C6\uC74C"],
      ["minimal", "\uCD5C\uC18C"],
      ["low", "\uB0AE\uC74C"],
      ["medium", "\uC911\uAC04"],
      ["high", "\uB192\uC74C"],
      ["xhigh", "\uB9E4\uC6B0 \uB192\uC74C"],
      ["max", "\uCD5C\uB300"]
    ];
    const serviceTierChoices = [["standard", "\uD45C\uC900"], ["flex", "Flex"], ["priority", "Priority"]];
    const providerChoices = [
      ["google", "Google AI Studio"],
      ["vertex", "Vertex AI"],
      ["openrouter", "OpenRouter"],
      ["vercel", "Vercel AI Gateway"],
      ["llmgateway", "LLM Gateway"]
    ];
    function reasoningChoices(provider) {
      return ["google", "vertex"].includes(provider) ? geminiReasoningChoices : gatewayReasoningChoices;
    }
    function modelProfileView(profile) {
      const prefix = `profile-${profile.id}`;
      const parameters = profile.parameters || {};
      return `<article class="pf-model-profile" data-profile-id="${html(profile.id)}">
      <div class="pf-model-header"><strong data-profile-title>${html(profile.name)}</strong><button class="pf-button danger" type="button" data-remove-profile>\uC0AD\uC81C</button></div>
      <div class="pf-grid">
        ${field(`${prefix}-name`, "\uD45C\uC2DC \uC774\uB984", profile.name, { placeholder: "PageFold Gemini 3.6 Flash" })}
        ${selectField(`${prefix}-provider`, "\uD504\uB85C\uBC14\uC774\uB354", profile.provider, providerChoices)}
        ${field(`${prefix}-model`, "\uC2E4\uC81C \uBAA8\uB378 ID", profile.model, { placeholder: "gemini-3.6-flash" })}
        ${field(`${prefix}-price`, "\uC785\uB825 \uB2E8\uAC00 (USD / 1M tokens)", profile.inputPrice, { type: "number", step: "0.0001", min: "0", help: "\uC774 \uBAA8\uB378\uC5D0\uB9CC \uC801\uC6A9\uB429\uB2C8\uB2E4. \uBE44\uC6CC\uB450\uBA74 \uAC00\uB2A5\uD55C \uACBD\uC6B0 \uC790\uB3D9\uC73C\uB85C \uC801\uC6A9\uD569\uB2C8\uB2E4." })}
        <div data-provider-route-field ${["openrouter", "vercel"].includes(profile.provider) ? "" : "hidden"}>${field(`${prefix}-route`, "\uD504\uB85C\uBC14\uC774\uB354 \uACE0\uC815", profile.providerRoute, { placeholder: "vertex", help: "\uC27C\uD45C\uB85C \uAD6C\uBD84\uD55C \uC5C5\uC2A4\uD2B8\uB9BC \uD504\uB85C\uBC14\uC774\uB354\uB97C \uC21C\uC11C\uB300\uB85C \uACE0\uC815\uD569\uB2C8\uB2E4." })}</div>
        ${selectField(`${prefix}-reasoning`, "\uCD94\uB860 \uAC15\uB3C4", profile.reasoningEffort, reasoningChoices(profile.provider), "\uC790\uB3D9\uC740 \uCD94\uB860 \uC124\uC815\uC744 \uD504\uB85C\uBC14\uC774\uB354 \uAE30\uBCF8\uAC12\uC5D0 \uB9E1\uAE41\uB2C8\uB2E4.")}
        ${selectField(`${prefix}-tier`, "\uC11C\uBE44\uC2A4 \uD2F0\uC5B4", profile.serviceTier, serviceTierChoices, "\uC9C0\uC6D0 \uBAA8\uB378\uC5D0\uC11C\uB9CC \uB3D9\uC791\uD569\uB2C8\uB2E4.")}
      </div>
      <details class="pf-advanced">
        <summary>\uACE0\uAE09 \uD30C\uB77C\uBBF8\uD130</summary>
        <div class="pf-advanced-body">
          <p class="pf-help">\uBE44\uC6CC\uB454 \uD56D\uBAA9\uC740 RisuAI \uB610\uB294 RisuBard\uC5D0\uC11C \uC804\uB2EC\uB41C \uAC12\uC744 \uADF8\uB300\uB85C \uC0AC\uC6A9\uD569\uB2C8\uB2E4. \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uB77C\uBBF8\uD130\uB294 \uD504\uB85C\uBC14\uC774\uB354\uB098 \uBAA8\uB378\uC5D0\uC11C \uAC70\uBD80\uB420 \uC218 \uC788\uC2B5\uB2C8\uB2E4.</p>
          <div class="pf-grid">
            ${field(`${prefix}-temperature`, "Temperature", parameters.temperature, { type: "number", step: "0.01", min: "0", max: "2", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-top-p`, "Top P", parameters.top_p, { type: "number", step: "0.01", min: "0", max: "1", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-top-k`, "Top K", parameters.top_k, { type: "number", step: "1", min: "1", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-min-p`, "Min P", parameters.min_p, { type: "number", step: "0.01", min: "0", max: "1", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-frequency-penalty`, "Frequency penalty", parameters.frequency_penalty, { type: "number", step: "0.01", min: "-2", max: "2", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-presence-penalty`, "Presence penalty", parameters.presence_penalty, { type: "number", step: "0.01", min: "-2", max: "2", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-repetition-penalty`, "Repetition penalty", parameters.repetition_penalty, { type: "number", step: "0.01", min: "0", max: "2", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
            ${field(`${prefix}-max-tokens`, "\uCD5C\uB300 \uCD9C\uB825 \uD1A0\uD070", parameters.max_tokens, { type: "number", step: "1", min: "1", placeholder: "Risu \uC124\uC815 \uC0AC\uC6A9" })}
          </div>
        </div>
      </details>
      <div class="pf-model-footer">
        ${checkboxField(`${prefix}-streaming`, "\uC2A4\uD2B8\uB9AC\uBC0D \uC694\uCCAD", profile.streaming, "\uC2A4\uD2B8\uB9AC\uBC0D \uC0AC\uC6A9 \uC2DC \uD558\uC774\uD30C \uC0AC\uC6A9\uC774 \uBD88\uAC00\uB2A5\uD569\uB2C8\uB2E4.")}
        <div class="pf-connection"><span class="pf-connection-result" data-connection-result aria-live="polite"></span><button class="pf-button" type="button" data-test-profile>\uC5F0\uACB0 \uD14C\uC2A4\uD2B8</button></div>
      </div>
    </article>`;
    }
    function settingsView() {
      return `<div id="pf-settings"><div class="pf-grid">
      <section class="pf-card full"><h2>PDF \uD328\uD0A4\uC9D5</h2>
        ${selectField("packaging-mode", "\uD328\uD0A4\uC9D5 \uBAA8\uB4DC", config.packagingMode, [["maximum", "\uC808\uC57D"], ["balanced", "\uC548\uC815"], ["marked", "\uB9C8\uCEE4"], ["marked_combined", "\uB9C8\uCEE4(\uD1B5\uD569)"]], "\uC808\uC57D\uC740 \uC804\uCCB4 \uB300\uD654\uB97C PDF\uC5D0 \uB123\uACE0, \uC548\uC815\uC740 system\uB9CC \uC6D0\uBB38\uC73C\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4. \uB9C8\uCEE4\uB294 \uC774\uB984\uBCC4 PDF\uB97C \uB9CC\uB4E4\uACE0, \uB9C8\uCEE4(\uD1B5\uD569)\uB294 name\uC744 \uBB34\uC2DC\uD574 \uBAA8\uB4E0 &lt;pdf&gt; \uBE14\uB85D\uC744 root PDF \uD558\uB098\uB85C \uBCF4\uB0C5\uB2C8\uB2E4.")}
        ${field("pdf-font-size", "PDF \uAE00\uC790 \uD06C\uAE30 (pt)", config.pdfFontSize, { type: "number", step: "0.1", min: "0.5", max: "12", help: "\uAE30\uBCF8\uAC12\uC740 1pt\uC785\uB2C8\uB2E4. \uC791\uC744\uC218\uB85D \uD55C \uD398\uC774\uC9C0\uC5D0 \uB354 \uB9CE\uC740 \uBB38\uC790\uAC00 \uB4E4\uC5B4\uAC00\uBA70 \uC2E4\uC81C \uC694\uCCAD PDF\uC5D0\uB3C4 \uC801\uC6A9\uB429\uB2C8\uB2E4." })}
        ${checkboxField("merge-consecutive-roles", "\uC5F0\uC18D \uC5ED\uD560 \uBCD1\uD569", config.mergeConsecutiveRoles, "\uC5F0\uC18D\uB41C system \uB610\uB294 user \uBA54\uC2DC\uC9C0\uB97C \uD558\uB098\uB85C \uD569\uCCD0 PDF \uC804\uC1A1\uB7C9\uC744 \uC904\uC785\uB2C8\uB2E4. \uC5B4\uC2DC\uC2A4\uD134\uD2B8 \uBA54\uC2DC\uC9C0\uB294 \uD56D\uC0C1 \uAC1C\uBCC4 \uC720\uC9C0\uB429\uB2C8\uB2E4.")}
        ${checkboxField("request-toast", "\uC694\uCCAD \uD1A0\uC2A4\uD2B8 \uB744\uC6B0\uAE30", config.requestToast)}
      </section>
      <section class="pf-card full"><h2>\uB4F1\uB85D \uBAA8\uB378</h2>
        <p class="pf-help">\uC5EC\uAE30\uC5D0 \uB4F1\uB85D\uD55C \uD504\uB85C\uD544\uB9CC RisuAI \uBAA8\uB378 \uBAA9\uB85D\uC5D0 \uD45C\uC2DC\uB429\uB2C8\uB2E4. \uCD94\uAC00\xB7\uC0AD\uC81C\xB7\uC774\uB984 \uBCC0\uACBD\uC740 \uC800\uC7A5 \uD6C4 \uD50C\uB7EC\uADF8\uC778\uC744 \uB2E4\uC2DC \uBD88\uB7EC\uC624\uBA74 \uC801\uC6A9\uB429\uB2C8\uB2E4.</p>
        <div id="pf-model-list" class="pf-model-list">${config.models.map(modelProfileView).join("")}</div>
        ${config.models.length ? "" : '<div id="pf-no-models" class="pf-empty">\uB4F1\uB85D\uB41C \uBAA8\uB378\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</div>'}
        <div class="pf-actions"><button id="pf-add-model" class="pf-button" type="button">\uBAA8\uB378 \uCD94\uAC00</button></div>
      </section>
      <section class="pf-card full pf-provider" data-provider="google"><h2>Google AI Studio</h2>
        ${field("google-key", "API \uD0A4", config.google.apiKey, { type: "password" })}
        ${field("google-url", "Base URL", config.google.baseUrl)}
      </section>
      <section class="pf-card full pf-provider" data-provider="vertex"><h2>Vertex AI</h2>
        ${selectField("vertex-auth", "\uC778\uC99D \uBC29\uC2DD", config.vertex.authMode, [["access_token", "Access token"], ["service_account", "Service account JSON"]])}
        ${field("vertex-token", "Access token", config.vertex.accessToken, { type: "password" })}
        ${field("vertex-service-account", "Service account JSON", config.vertex.serviceAccount, { type: "textarea", placeholder: '{"type":"service_account", ...}' })}
        ${field("vertex-project", "Project ID", config.vertex.projectId)}
        ${field("vertex-location", "Location", config.vertex.location, { placeholder: "global" })}
      </section>
      <section class="pf-card full pf-provider" data-provider="openrouter"><h2>OpenRouter</h2>
        ${field("openrouter-key", "API \uD0A4", config.openrouter.apiKey, { type: "password" })}
        ${field("openrouter-url", "Base URL", config.openrouter.baseUrl)}
      </section>
      <section class="pf-card full pf-provider" data-provider="vercel"><h2>Vercel AI Gateway</h2>
        ${field("vercel-key", "API \uD0A4", config.vercel.apiKey, { type: "password" })}
        ${field("vercel-url", "Base URL", config.vercel.baseUrl)}
      </section>
      <section class="pf-card full pf-provider" data-provider="llmgateway"><h2>LLM Gateway</h2>
        ${field("llmgateway-key", "API \uD0A4", config.llmgateway.apiKey, { type: "password" })}
        ${field("llmgateway-url", "Base URL", config.llmgateway.baseUrl)}
      </section>
    </div><div class="pf-actions"><button id="pf-save-settings" class="pf-button primary" type="button">\uC124\uC815 \uC800\uC7A5</button></div></div>`;
    }
    function requestStatusView(row) {
      const statusCode = Math.trunc(Number(row.statusCode) || 0);
      if (row.success) {
        return `<span class="pf-status success">${statusCode ? `\uC131\uACF5(${statusCode})` : "\uC131\uACF5"}</span>`;
      }
      if (row.failureKind === "aborted") return '<span class="pf-status aborted">\uC911\uB2E8</span>';
      const label = statusCode ? `\uC2E4\uD328(${statusCode})` : row.failureKind === "network" ? "\uC2E4\uD328(\uB124\uD2B8\uC6CC\uD06C)" : "\uC2E4\uD328";
      return `<span class="pf-status failure">${label}</span>`;
    }
    function requestLatencyView(value) {
      const latencyMs = Math.max(0, Number(value) || 0);
      if (!latencyMs) return '<span class="pf-stat-unavailable">\u2014</span>';
      const label = latencyMs < 1e3 ? `${number(latencyMs)}ms` : latencyMs < 6e4 ? `${number(latencyMs / 1e3, 1)}\uCD08` : `${Math.floor(latencyMs / 6e4)}\uBD84 ${number(latencyMs % 6e4 / 1e3, 1)}\uCD08`;
      return `<span title="${number(latencyMs)}ms">${label}</span>`;
    }
    async function statsView() {
      await Promise.all([statsWriteQueue, requestLogWriteQueue]);
      const [stats, requestLogs] = await Promise.all([loadStats(), loadRequestLogs()]);
      const total = stats.total || {};
      const routes = Object.entries(stats.routes || {});
      const recent = stats.recent || [];
      const requestLogIds = new Set(requestLogs.entries.map((entry) => entry.id));
      const totalInputTokens = Number(total.optimizedTokens) || 0;
      const totalOutputTokens = routes.reduce((sum, [key, row]) => {
        const [provider] = key.split("\0");
        return sum + outputTokenBreakdown(provider, row.outputTokens, row.reasoningTokens).total;
      }, 0);
      const totalReductionRate = Number(total.baselineTokens) > 0 ? (Number(total.savedTokens) || 0) / Number(total.baselineTokens) * 100 : 0;
      const pageSize = 10;
      const pageCount = Math.max(1, Math.ceil(recent.length / pageSize));
      statsPage = Math.min(Math.max(1, statsPage), pageCount);
      const pageStart = (statsPage - 1) * pageSize;
      const pageRecent = recent.slice(pageStart, pageStart + pageSize);
      const pageEnd = Math.min(pageStart + pageRecent.length, recent.length);
      const pagination = recent.length > pageSize ? `<div class="pf-pagination"><button class="pf-button" type="button" data-stats-page="${statsPage - 1}" ${statsPage === 1 ? "disabled" : ""}>\uC774\uC804</button><span class="pf-page-info">${number(pageStart + 1)}\u2013${number(pageEnd)} / ${number(recent.length)}</span><button class="pf-button" type="button" data-stats-page="${statsPage + 1}" ${statsPage === pageCount ? "disabled" : ""}>\uB2E4\uC74C</button></div>` : "";
      return `<div class="pf-stats-toolbar"><h2>\uD1B5\uACC4 \uC694\uC57D</h2><div class="pf-stats-actions"><label class="pf-log-switch"><input id="pf-request-logging" type="checkbox" ${config.requestLogging ? "checked" : ""}><span>\uC694\uCCAD \uB85C\uADF8 \uC800\uC7A5</span><small>\uCD5C\uADFC 20\uAC1C</small></label><button id="pf-export-logs" class="pf-button" type="button" ${requestLogs.entries.length ? "" : "disabled"}>\uB85C\uADF8 \uB0B4\uBCF4\uB0B4\uAE30</button><button id="pf-reset-stats" class="pf-button danger" type="button">\uD1B5\uACC4 \uCD08\uAE30\uD654</button></div></div>
    <div class="pf-stat-grid">
      <div class="pf-stat"><span>\uC804\uCCB4 \uC694\uCCAD</span><strong>${number(total.requests)}</strong></div>
      <div class="pf-stat"><span>\uCD1D \uC785\uB825 \uD1A0\uD070</span><strong>${number(totalInputTokens)}</strong></div>
      <div class="pf-stat"><span>\uCD1D \uCD9C\uB825 \uD1A0\uD070</span><strong>${number(totalOutputTokens)}</strong></div>
      <div class="pf-stat"><span>\uC808\uC57D\uB41C \uD1A0\uD070</span><strong>${number(total.savedTokens)}</strong></div>
      <div class="pf-stat"><span>\uC808\uC57D\uB960</span><strong>${number(totalReductionRate, 1)}%</strong></div>
      <div class="pf-stat"><span>\uC608\uC0C1 \uC808\uC57D\uC561</span><strong>${usd(total.savedUsd)}</strong></div>
      <div class="pf-stat"><span>\uC0DD\uC131 PDF \uD398\uC774\uC9C0</span><strong>${number(total.pdfPages)}</strong></div>
    </div>
    <section class="pf-card full"><h2>\uD504\uB85C\uBC14\uC774\uB354\xB7\uBAA8\uB378\uBCC4 \uD1B5\uACC4</h2><div class="pf-table-wrap">${routes.length ? `<table class="pf-table"><thead><tr><th>\uD504\uB85C\uBC14\uC774\uB354</th><th>\uBAA8\uB378</th><th>\uC694\uCCAD</th><th>\uC131\uACF5\uB960</th><th>\uC785\uB825 \uD1A0\uD070</th><th>\uCD9C\uB825 \uD1A0\uD070</th><th>\uC808\uC57D\uB41C \uD1A0\uD070</th><th>\uC608\uC0C1 \uC808\uC57D\uC561</th></tr></thead><tbody>${routes.map(([key, row]) => {
        const [provider, model] = key.split("\0");
        const successRate = row.requests ? row.successes / row.requests * 100 : 0;
        const outputTokens = outputTokenBreakdown(provider, row.outputTokens, row.reasoningTokens).total;
        return `<tr><td>${html(routeName(provider))}</td><td>${html(model)}</td><td>${number(row.requests)}</td><td>${number(successRate, 1)}%</td><td>${number(row.optimizedTokens)}</td><td>${number(outputTokens)}</td><td>${number(row.savedTokens)}</td><td>${usd(row.savedUsd)}</td></tr>`;
      }).join("")}</tbody></table>` : '<div class="pf-empty">\uC544\uC9C1 \uD1B5\uACC4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.</div>'}</div></section>
    <section class="pf-card full" style="margin-top:14px"><h2>\uCD5C\uADFC \uC694\uCCAD</h2><div class="pf-table-wrap">${pageRecent.length ? `<table class="pf-table"><thead><tr><th>\uC2DC\uAC04</th><th>\uACBD\uB85C</th><th>\uCD94\uB860</th><th>\uD2F0\uC5B4</th><th>PDF</th><th>\uC785\uB825 \uD1A0\uD070</th><th>\uCD9C\uB825 \uD1A0\uD070</th><th>\uC808\uC57D\uB960</th><th>\uC751\uB2F5 \uC2DC\uAC04</th><th>\uC0C1\uD0DC</th></tr></thead><tbody>${pageRecent.map((row) => {
        const baseline = Number(row.baselineTokens) || 0;
        const optimized = Number(row.optimizedTokens) || 0;
        const delta = optimized - baseline;
        const reductionRate = baseline > 0 ? (Number(row.savedTokens) || 0) / baseline * 100 : 0;
        const serviceTier = normalizeServiceTier(row.servedServiceTier || row.requestedServiceTier);
        const tokenCell = row.success ? `<span class="pf-token-flow"><span class="pf-token-baseline">${number(baseline)}</span><span class="pf-token-arrow">\u2192</span><span class="pf-token-optimized">${number(optimized)}</span><span class="pf-token-delta">(${delta > 0 ? "+" : ""}${number(delta)})</span></span>` : '<span class="pf-stat-unavailable">\u2014</span>';
        const outputCell = row.success ? number(outputTokenBreakdown(row.provider, row.outputTokens, row.reasoningTokens).total) : '<span class="pf-stat-unavailable">\u2014</span>';
        const rateCell = row.success ? `${number(reductionRate, 1)}%` : '<span class="pf-stat-unavailable">\u2014</span>';
        const hasLog = Boolean(row.logId && requestLogIds.has(row.logId));
        return `<tr ${hasLog ? `class="pf-log-row" data-request-log-id="${html(row.logId)}" tabindex="0" title="\uC694\uCCAD \uB85C\uADF8 \uBCF4\uAE30"` : ""}><td>${html(new Date(row.timestamp).toLocaleString())}</td><td>${html(routeName(row.provider))} / ${html(row.model)}</td><td>${html(row.reasoningEffort || "\uC790\uB3D9")}</td><td>${html(serviceTier)}</td><td>${number(row.pdfPages)}p</td><td>${tokenCell}</td><td>${outputCell}</td><td>${rateCell}</td><td>${requestLatencyView(row.latencyMs)}</td><td>${requestStatusView(row)}</td></tr>`;
      }).join("")}</tbody></table>` : '<div class="pf-empty">\uC544\uC9C1 \uC694\uCCAD \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</div>'}</div>${pagination}</section>`;
    }
    function requestLogBodyText(value) {
      if (value === null || value === void 0) return "\uAE30\uB85D\uB41C \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch (_error) {
        return String(value);
      }
    }
    function exportFileTimestamp(date = /* @__PURE__ */ new Date()) {
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }
    function downloadJsonFile(filename, value) {
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const linkId = `pf-download-${Date.now().toString(36)}`;
      document.body.insertAdjacentHTML("beforeend", `<a id="${linkId}" hidden download="${html(filename)}"></a>`);
      const link = document.getElementById(linkId);
      if (!link) {
        URL.revokeObjectURL(url);
        throw new Error("\uB2E4\uC6B4\uB85C\uB4DC \uB9C1\uD06C\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      }
      link.href = url;
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e4);
    }
    async function exportRequestLogs() {
      await requestLogWriteQueue;
      const logs = await loadRequestLogs();
      if (!logs.entries.length) return false;
      if (typeof confirm === "function" && !confirm("\uB0B4\uBCF4\uB0BC \uD30C\uC77C\uC5D0\uB294 \uB300\uD654\uC640 \uD504\uB86C\uD504\uD2B8 \uB0B4\uC6A9\uC774 \uD3EC\uD568\uB429\uB2C8\uB2E4. \uACC4\uC18D\uD560\uAE4C\uC694?")) return false;
      const now = /* @__PURE__ */ new Date();
      downloadJsonFile(
        `pagefold-logs-${exportFileTimestamp(now)}.json`,
        createRequestLogExport(logs, {
          pluginVersion: PAGEFOLD_VERSION,
          exportedAt: now.toISOString()
        })
      );
      return true;
    }
    async function openRequestLog(logId) {
      await requestLogWriteQueue;
      const logs = await loadRequestLogs();
      const entry = logs.entries.find((item) => item.id === logId);
      if (!entry) return;
      document.getElementById("pf-request-log-modal")?.remove();
      const outputUsage = outputTokenBreakdown(entry.provider, entry.outputTokens, entry.reasoningTokens);
      const tokenMetadata = entry.success && (Number(entry.inputTokens) > 0 || outputUsage.total > 0) ? ` \xB7 \uC785\uB825 ${number(entry.inputTokens)} \xB7 \uCD9C\uB825 ${number(outputUsage.total)} (\uC751\uB2F5 ${number(entry.responseTokens ?? outputUsage.response)} + \uCD94\uB860 ${number(entry.reasoningTokens)})` : "";
      const metadata = `${new Date(entry.timestamp).toLocaleString()} \xB7 ${routeName(entry.provider)} / ${entry.model}${Number(entry.latencyMs) > 0 ? ` \xB7 ${number(entry.latencyMs)}ms` : ""}${tokenMetadata} \xB7 ${entry.success ? "\uC131\uACF5" : "\uC2E4\uD328"}`;
      document.body.insertAdjacentHTML("beforeend", `<div id="pf-request-log-modal" class="pf-modal" role="presentation">
      <div class="pf-log-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-request-log-title">
        <header class="pf-log-header"><div><h2 id="pf-request-log-title">\uC694\uCCAD \uB85C\uADF8</h2><div class="pf-log-meta">${html(metadata)}</div></div><button class="pf-log-close" type="button" aria-label="\uB2EB\uAE30">\xD7</button></header>
        <nav class="pf-log-tabs"><button class="pf-log-tab active" type="button" data-log-tab="request">\uC694\uCCAD \uBCF8\uBB38</button><button class="pf-log-tab" type="button" data-log-tab="pdf">PDF \uB0B4\uC6A9</button><button class="pf-log-tab" type="button" data-log-tab="response">\uC751\uB2F5 \uBCF8\uBB38</button></nav>
        <div class="pf-log-content">
          <section class="pf-log-panel" data-log-panel="request"><pre>${html(requestLogBodyText(entry.requestBody))}</pre></section>
          <section class="pf-log-panel" data-log-panel="pdf" hidden><p class="pf-log-panel-info">${number(entry.pdfPages)}\uD398\uC774\uC9C0 \xB7 ${number(entry.pdfBytes)} bytes</p><pre>${html(entry.pdfContent || "\uAE30\uB85D\uB41C PDF \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.")}</pre></section>
          <section class="pf-log-panel" data-log-panel="response" hidden><pre>${html(requestLogBodyText(entry.responseBody))}</pre></section>
        </div>
      </div>
    </div>`);
      const modal = document.getElementById("pf-request-log-modal");
      const close = () => {
        document.removeEventListener("keydown", onKeyDown);
        modal?.remove();
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") close();
      };
      modal?.querySelector(".pf-log-close")?.addEventListener("click", close);
      modal?.addEventListener("click", (event) => {
        if (event.target === modal) close();
      });
      modal?.querySelectorAll("[data-log-tab]").forEach((button) => button.addEventListener("click", () => {
        modal.querySelectorAll("[data-log-tab]").forEach((item) => item.classList.toggle("active", item === button));
        modal.querySelectorAll("[data-log-panel]").forEach((panel) => {
          panel.hidden = panel.dataset.logPanel !== button.dataset.logTab;
        });
      }));
      document.addEventListener("keydown", onKeyDown);
    }
    let newProfileSequence = 0;
    function newProfileId() {
      newProfileSequence += 1;
      return `model-${Date.now().toString(36)}-${newProfileSequence.toString(36)}`;
    }
    function settingsFormConfig() {
      const get = (id) => document.getElementById(id)?.value ?? "";
      const checked = (id) => document.getElementById(id)?.checked === true;
      const models = Array.from(document.querySelectorAll(".pf-model-profile")).map((row) => {
        const id = row.dataset.profileId;
        return {
          id,
          name: get(`profile-${id}-name`),
          provider: get(`profile-${id}-provider`),
          model: get(`profile-${id}-model`),
          reasoningEffort: get(`profile-${id}-reasoning`),
          serviceTier: get(`profile-${id}-tier`),
          streaming: checked(`profile-${id}-streaming`),
          providerRoute: get(`profile-${id}-route`),
          inputPrice: get(`profile-${id}-price`),
          parameters: {
            temperature: get(`profile-${id}-temperature`),
            top_p: get(`profile-${id}-top-p`),
            top_k: get(`profile-${id}-top-k`),
            min_p: get(`profile-${id}-min-p`),
            frequency_penalty: get(`profile-${id}-frequency-penalty`),
            presence_penalty: get(`profile-${id}-presence-penalty`),
            repetition_penalty: get(`profile-${id}-repetition-penalty`),
            max_tokens: get(`profile-${id}-max-tokens`)
          }
        };
      });
      return normalizeConfig({
        ...config,
        packagingMode: get("packaging-mode"),
        pdfFontSize: Number(get("pdf-font-size")),
        mergeConsecutiveRoles: checked("merge-consecutive-roles"),
        requestToast: checked("request-toast"),
        models,
        google: {
          ...config.google,
          apiKey: get("google-key"),
          baseUrl: get("google-url")
        },
        vertex: {
          ...config.vertex,
          authMode: get("vertex-auth"),
          accessToken: get("vertex-token"),
          serviceAccount: get("vertex-service-account"),
          projectId: get("vertex-project"),
          location: get("vertex-location")
        },
        openrouter: {
          ...config.openrouter,
          apiKey: get("openrouter-key"),
          baseUrl: get("openrouter-url")
        },
        vercel: {
          ...config.vercel,
          apiKey: get("vercel-key"),
          baseUrl: get("vercel-url")
        },
        llmgateway: {
          ...config.llmgateway,
          apiKey: get("llmgateway-key"),
          baseUrl: get("llmgateway-url")
        }
      });
    }
    function updateProfileReasoningChoices(row) {
      const id = row.dataset.profileId;
      const provider = document.getElementById(`profile-${id}-provider`)?.value || "google";
      const providerRouteField = row.querySelector("[data-provider-route-field]");
      if (providerRouteField) providerRouteField.hidden = !["openrouter", "vercel"].includes(provider);
      const select = document.getElementById(`profile-${id}-reasoning`);
      if (!select) return;
      const choices = reasoningChoices(provider);
      const current = choices.some(([value]) => value === select.value) ? select.value : "auto";
      select.innerHTML = choices.map(([value, label]) => `<option value="${html(value)}" ${value === current ? "selected" : ""}>${html(label)}</option>`).join("");
    }
    function bindProfileRow(row) {
      const id = row.dataset.profileId;
      row.querySelector("[data-remove-profile]")?.addEventListener("click", () => {
        row.remove();
        if (!document.querySelector(".pf-model-profile")) {
          document.getElementById("pf-model-list")?.insertAdjacentHTML(
            "afterend",
            '<div id="pf-no-models" class="pf-empty">\uB4F1\uB85D\uB41C \uBAA8\uB378\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</div>'
          );
        }
      });
      document.getElementById(`profile-${id}-provider`)?.addEventListener("change", () => {
        updateProfileReasoningChoices(row);
      });
      document.getElementById(`profile-${id}-name`)?.addEventListener("input", (event) => {
        const title = row.querySelector("[data-profile-title]");
        if (title) title.textContent = event.target.value || "\uC774\uB984 \uC5C6\uB294 \uBAA8\uB378";
      });
      row.querySelector("[data-test-profile]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const result = row.querySelector("[data-connection-result]");
        const draftConfig = settingsFormConfig();
        const profile = draftConfig.models.find((entry) => entry.id === id);
        if (!profile) return;
        const startedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6e4);
        button.disabled = true;
        button.textContent = "\uD14C\uC2A4\uD2B8 \uC911\u2026";
        result.textContent = "";
        result.className = "pf-connection-result";
        try {
          await testProfileConnection(profileConfig(draftConfig, profile), controller.signal);
          const elapsed = Date.now() - startedAt;
          result.textContent = `\uC5F0\uACB0 \uC131\uACF5 \xB7 ${number(elapsed)}ms`;
          result.className = "pf-connection-result success";
          console.info(`[PageFold] \uC5F0\uACB0 \uD14C\uC2A4\uD2B8 \uC131\uACF5 \xB7 ${profile.provider} / ${profile.model} \xB7 ${elapsed}ms`);
        } catch (error) {
          const elapsed = Date.now() - startedAt;
          result.textContent = `\uC5F0\uACB0 \uC2E4\uD328 \xB7 ${number(elapsed)}ms`;
          result.className = "pf-connection-result failure";
          console.error(`[PageFold] \uC5F0\uACB0 \uD14C\uC2A4\uD2B8 \uC2E4\uD328 \xB7 ${profile.provider} / ${profile.model} \xB7 ${elapsed}ms`, error);
        } finally {
          clearTimeout(timeout);
          button.disabled = false;
          button.textContent = "\uC5F0\uACB0 \uD14C\uC2A4\uD2B8";
        }
      });
    }
    async function renderApp(tab = "settings", message = "", warning = false) {
      ensureStyles();
      config = await loadConfig();
      const activeTab = tab === "stats" ? "stats" : "settings";
      document.body.innerHTML = `<main class="pf-app"><div class="pf-shell">
      <header class="pf-header"><h1 class="pf-title">PageFold</h1><button id="pf-close" class="pf-close" aria-label="\uB2EB\uAE30">\xD7</button></header>
      <nav class="pf-tabs" role="tablist"><button class="pf-tab ${activeTab === "settings" ? "active" : ""}" data-tab="settings" role="tab">\uC124\uC815</button><button class="pf-tab ${activeTab === "stats" ? "active" : ""}" data-tab="stats" role="tab">\uD1B5\uACC4</button></nav>
      ${message ? `<div class="pf-message ${warning ? "warning" : ""}">${html(message)}</div>` : ""}
      <div id="pf-view">${activeTab === "stats" ? await statsView() : settingsView()}</div>
    </div></main>`;
      document.getElementById("pf-close")?.addEventListener("click", () => {
        api.hideContainer();
      });
      document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
        if (button.dataset.tab === "stats") statsPage = 1;
        renderApp(button.dataset.tab);
      }));
      document.querySelectorAll("[data-stats-page]").forEach((button) => button.addEventListener("click", () => {
        if (button.disabled) return;
        statsPage = Math.max(1, Number(button.dataset.statsPage) || 1);
        renderApp("stats");
      }));
      document.getElementById("pf-request-logging")?.addEventListener("change", async (event) => {
        const enabled = event.target.checked === true;
        await persistConfig({ ...config, requestLogging: enabled });
        await renderApp(
          "stats",
          enabled ? "\uC694\uCCAD \uB85C\uADF8 \uC800\uC7A5\uC744 \uCF30\uC2B5\uB2C8\uB2E4. \uC774\uD6C4 \uC694\uCCAD\uBD80\uD130 \uCD5C\uADFC 20\uAC1C\uB97C \uC800\uC7A5\uD569\uB2C8\uB2E4." : "\uC694\uCCAD \uB85C\uADF8 \uC800\uC7A5\uC744 \uAED0\uC2B5\uB2C8\uB2E4. \uAE30\uC874 \uB85C\uADF8\uB294 \uC720\uC9C0\uB429\uB2C8\uB2E4."
        );
      });
      document.getElementById("pf-export-logs")?.addEventListener("click", async () => {
        try {
          if (await exportRequestLogs()) await renderApp("stats", "\uC694\uCCAD \uB85C\uADF8\uB97C JSON \uD30C\uC77C\uB85C \uB0B4\uBCF4\uB0C8\uC2B5\uB2C8\uB2E4.");
        } catch (error) {
          console.error("[PageFold] \uC694\uCCAD \uB85C\uADF8 \uB0B4\uBCF4\uB0B4\uAE30 \uC2E4\uD328", error);
          await renderApp("stats", "\uC694\uCCAD \uB85C\uADF8\uB97C \uB0B4\uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", true);
        }
      });
      document.querySelectorAll("[data-request-log-id]").forEach((row) => {
        const open = () => openRequestLog(row.dataset.requestLogId);
        row.addEventListener("click", open);
        row.addEventListener("keydown", (event) => {
          if (!["Enter", " "].includes(event.key)) return;
          event.preventDefault();
          open();
        });
      });
      document.querySelectorAll(".pf-model-profile").forEach(bindProfileRow);
      document.getElementById("pf-add-model")?.addEventListener("click", () => {
        const provider = config.models.at(-1)?.provider || "google";
        const route = config[provider];
        const profile = {
          id: newProfileId(),
          name: modelProfileDisplayName(route.model),
          provider,
          model: route.model,
          reasoningEffort: "auto",
          serviceTier: "standard",
          streaming: false,
          inputPrice: route.inputPrice ?? "",
          parameters: {}
        };
        document.getElementById("pf-no-models")?.remove();
        const list = document.getElementById("pf-model-list");
        list?.insertAdjacentHTML("beforeend", modelProfileView(profile));
        const row = list?.lastElementChild;
        if (row) bindProfileRow(row);
      });
      document.getElementById("pf-save-settings")?.addEventListener("click", async () => {
        const nextConfig = settingsFormConfig();
        const providerRegistrationChanged = providerRegistrationSignature(nextConfig.models) !== providerRegistrationSignature(config.models) || nextConfig.requestToast !== config.requestToast;
        await persistConfig(nextConfig);
        await renderApp(
          "settings",
          providerRegistrationChanged ? "\u26A0\uFE0F \uD504\uB85C\uBC14\uC774\uB354 \uB4F1\uB85D \uC124\uC815\uC774 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. RisuAI\uB97C \uB2E4\uC2DC \uB85C\uB4DC\uD574\uC57C \uC801\uC6A9\uB429\uB2C8\uB2E4." : "\uC124\uC815\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.",
          providerRegistrationChanged
        );
      });
      document.getElementById("pf-reset-stats")?.addEventListener("click", async () => {
        if (typeof confirm === "function" && !confirm("PageFold \uD1B5\uACC4\uC640 \uC800\uC7A5\uB41C \uC694\uCCAD \uB85C\uADF8\uB97C \uCD08\uAE30\uD654\uD560\uAE4C\uC694?")) return;
        await Promise.all([statsWriteQueue, requestLogWriteQueue]);
        await localStorage.removeItem(STATS_KEY);
        await localStorage.removeItem(REQUEST_LOGS_KEY);
        statsPage = 1;
        await renderApp("stats", "\uD1B5\uACC4\uC640 \uC694\uCCAD \uB85C\uADF8\uB97C \uCD08\uAE30\uD654\uD588\uC2B5\uB2C8\uB2E4.");
      });
    }
    await api.registerSetting("PageFold", async () => {
      await renderApp("settings");
      await api.showContainer("fullscreen");
    }, "PF", "html", PAGEFOLD_ID);
    // RisuVault: the host dispatches every ModelPreset with the PageFold
    // toggle through builtInProviders.get("PageFold"), so this fixed provider
    // must exist regardless of how many profiles are configured. It only
    // serves preset routes (profileId null). Registered first so a later
    // profile registration can never replace it.
    await api.addProvider(
      PRESET_ROUTE_PROVIDER_NAME,
      (args, signal) => runProvider(args, signal, null),
      {
        structuredOutput: true,
        overrideRequestStatus: config.requestToast === true,
        model: {
          name: PRESET_ROUTE_PROVIDER_NAME,
          shortName: PRESET_ROUTE_PROVIDER_NAME,
          fullName: PRESET_ROUTE_PROVIDER_NAME,
          internalID: `pluginmodel:::${PRESET_ROUTE_PROVIDER_NAME}`,
          flags: [6]
        }
      }
    );
    for (const profile of config.models) {
      const registrationName = profileRegistrationName(profile);
      // RisuVault: profile names are always "pagefold-<model>" so this cannot
      // happen today, but the host re-registers by name and would swap the
      // preset provider for a profile one; skip rather than clobber it.
      if (registrationName.trim() === PRESET_ROUTE_PROVIDER_NAME) {
        console.warn(`[PageFold] \uD504\uB85C\uD544 '${profile.name}'\uC758 \uB4F1\uB85D \uC774\uB984\uC774 \uC608\uC57D\uB41C \uC774\uB984\uACFC \uACB9\uCCD0 \uAC74\uB108\uB701\uB2C8\uB2E4.`);
        continue;
      }
      await api.addProvider(
        registrationName,
        (args, signal) => runProvider(args, signal, profile.id),
        {
          structuredOutput: true,
          overrideRequestStatus: config.requestToast === true,
          model: {
            name: profile.name,
            shortName: profile.name,
            fullName: profile.name,
            internalID: `pluginmodel:::${registrationName}`,
            flags: profile.streaming ? [6, 8] : [6]
          }
        }
      );
    }
    console.log(`PageFold v${PAGEFOLD_VERSION} initialized \xB7 ${config.models.length} model profile(s)`);
  })().catch((error) => console.error("PageFold initialization failed:", error));
})();
