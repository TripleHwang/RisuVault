// @vitest-environment node
/**
 * The prompt-history preload, against a REAL spawned server.
 *
 * Node environment for the same reason as `sqlReversePageLive.svelte.test.ts`:
 * happy-dom's `fetch` enforces the same-origin policy and cannot reach
 * `http://127.0.0.1:<port>`.
 *
 * Nothing below the HTTP boundary is stubbed. `ensureChatMessageWindow`,
 * `loadOlderChatMessages`, `loadNewestChatMessages` and the reverse-page
 * validators are the real ones, reading real rows out of SQLite through the
 * same storage object the app builds at boot. The only injected policy is the
 * token `measure`, which is a caller-supplied function by design -- in the app
 * it is the real `ChatTokenizer`.
 *
 * The bug this covers: a chat opens on its newest 40 messages
 * (`hydrateRecentChatPage(chats, index, chaId, 40)`), so every conversation
 * longer than 40 messages had `hasOlder === true` and `sendChat` refused with
 * "Load earlier messages before generating" until the reader had scrolled all
 * the way back to the first message.
 */
import { flushSync } from "svelte";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Chat, Database, character } from "../database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const {
  ensureChatMessageWindow,
  loadOlderChatMessages,
  MAX_RESIDENT_MESSAGES,
} = await import("./sqlRuntimeHydration");
const { getSqlPosition, getSqlWindow, isSqlWindowPartial, hasNewerSqlMessages } = await import("./sqlRuntimeWindow");
const { isSqlMessageDirty } = await import("./sqlPersistenceRuntime");
const { ensurePromptHistoryResident } = await import("./promptHistoryPreload");
const { resolvePromptHistoryBound } = await import("../../process/promptHistoryBound");
const {
  beginResidencyPin,
  endResidencyPin,
  isResidencyPinned,
  resetResidencyPinsForTesting,
} = await import("./residencyPin");
const { endAllGenerations, endGeneration, startGeneration } = await import("../../process/generationState");
const { capturePromptPreloadTarget, promptPreloadTargetMoved } = await import("../../process/promptPreloadTarget");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");
type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

const CHARACTER_ID = "character-prompt-history";

/** What a chat opens on. `chatStorage.ts:499` passes exactly this. */
const OPEN_PAGE = 40;

/**
 * Deterministic stand-in for the tokenizer, applied to the same text the prompt
 * builds its `OpenAIChat.content` from. Every seeded message is padded to the
 * same length, so the budget arithmetic in these tests is exact.
 */
const TOKENS_PER_MESSAGE = 10;
async function measure(messages: Array<{ data?: string }>): Promise<number> {
  return messages.reduce((total, message) => total + Math.ceil((message.data ?? "").length / 4), 0);
}

/** 40 characters -> exactly TOKENS_PER_MESSAGE under `measure`. */
function messageBody(index: number): string {
  return `message ${String(index).padStart(4, "0")}`.padEnd(40, ".");
}

let server: ServerHandle;
let storage: InstanceType<typeof NodeSqliteStorage>;
let port: number;
let password: string;

/**
 * A message that costs 88 tokens under `measure`, which is what the messages of
 * the real 1200-message conversation this file re-measures cost through the
 * real tokenizer. 65,000 / 88 is 739, and that is where the pre-bound walk
 * stopped: 740 resident after 7 pages.
 */
const REAL_TOKENS_PER_MESSAGE = 88;
function realisticBody(index: number): string {
  return `message ${String(index).padStart(4, "0")} `.padEnd(REAL_TOKENS_PER_MESSAGE * 4, ".");
}

interface Seed {
  chatId: string;
  length: number;
  body?: (index: number) => string;
  /** `disabled === true`, which `makeMs` skips and the prompt never sees. */
  disabled?: (index: number) => boolean;
}

function legacyDatabase(seeds: Seed[]): Database {
  return {
    apiType: "openai",
    username: "reporter",
    maxContext: 4000,
    personas: [{ name: "Default", icon: "", personaPrompt: "" }],
    botPresets: [],
    botPresetsId: 0,
    modules: [],
    pluginCustomStorage: {},
    characters: [{
      chaId: CHARACTER_ID,
      type: "character",
      name: "Ada",
      image: "",
      desc: "",
      firstMessage: "Hello, this is the greeting.",
      alternateGreetings: [],
      chatPage: 0,
      chats: seeds.map(({ chatId, length, body, disabled }, chatIndex) => ({
        id: chatId,
        name: `Chat ${chatIndex}`,
        note: "",
        localLore: [],
        message: Array.from({ length }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "char",
          data: (body ?? messageBody)(index),
          chatId: `${chatId}-msg-${String(index).padStart(4, "0")}`,
          ...(disabled?.(index) ? { disabled: true } : {}),
        })),
      })),
    }],
  } as unknown as Database;
}

/** The live database exactly as the app holds it: `$state`, chat unhydrated. */
function reactiveDatabase(chatId: string): { db: Database; character: character } {
  const db = $state({
    characters: [{
      chaId: CHARACTER_ID,
      chatPage: 0,
      chats: [{
        id: chatId,
        name: "Chat 0",
        note: "",
        localLore: [],
        message: [] as any[],
        _placeholder: true,
        messagesLoaded: false,
      }],
    }],
  });
  return { db: db as unknown as Database, character: db.characters[0] as unknown as character };
}

/** Open a chat the way `hydrateRecentChatPage` does: newest 40, nothing else. */
async function openChat(chatId: string, limit = OPEN_PAGE): Promise<character> {
  const { character } = reactiveDatabase(chatId);
  await ensureChatMessageWindow(character, 0, limit);
  flushSync();
  return character;
}

function residentIds(chat: Chat): string[] {
  return (chat.message ?? []).map((message) => message.chatId!);
}

const SHORT = 10;
const OPENED = 100;
const LONG = 600;
/** Comfortably past MAX_RESIDENT_MESSAGES (320), so a full walk back trims. */
const TRIMMING = 420;
/** The conversation the pre-bound walk was measured on: 740 resident, 7 pages. */
const MEASURED = 1_200;
/** `resolvePromptContextBudget`'s ModelPreset branch, `index.svelte.ts:851`. */
const MODEL_PRESET_BUDGET = 65_000;

describe("loading the history a prompt needs before generating", () => {
  beforeAll(async () => {
    server = await spawnServer();
    port = server.port;
    password = server.password;
    const client = await createClient(port, password);
    storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase([
      { chatId: "chat-short", length: SHORT },
      { chatId: "chat-opened", length: OPENED },
      { chatId: "chat-budget", length: LONG },
      { chatId: "chat-failing", length: OPENED },
      { chatId: "chat-restore", length: TRIMMING },
      { chatId: "chat-bound", length: TRIMMING },
      { chatId: "chat-untrimmed-control", length: TRIMMING },
      { chatId: "chat-generating", length: TRIMMING },
      { chatId: "chat-progress", length: TRIMMING },
      { chatId: "chat-aborted", length: TRIMMING },
      { chatId: "chat-marks", length: TRIMMING },
      { chatId: "chat-halfway", length: TRIMMING },
      { chatId: "chat-restore-fails", length: TRIMMING },
      { chatId: "chat-vanishing", length: TRIMMING },
      { chatId: "chat-measure", length: MEASURED, body: realisticBody },
      // Two of every three recent messages disabled: the shape the raw
      // target's settings-only guess (`visible + 8` slots) is wrong about, so
      // the walk has to read the messages to find out. Visible messages are
      // the indices divisible by three, 400 of the 1200; the newest resident
      // slice of N messages holds about N / 3 of them.
      { chatId: "chat-disabled", length: MEASURED, disabled: (index) => index % 3 !== 0 },
    ]))).toBe(true);
    activeStorage.current = storage;
  }, 120_000);

  afterEach(() => {
    endAllGenerations();
    resetResidencyPinsForTesting();
    activeStorage.current = storage;
  });

  afterAll(async () => {
    activeStorage.current = null;
    await server?.cleanup();
  });

  // ── The failing case ────────────────────────────────────────────────────

  it("makes a chat longer than the open page sendable without the user scrolling", async () => {
    const character = await openChat("chat-opened");

    // This is the state `sendChat` refused on, reproduced through the real
    // hydrator: a normally opened chat, 40 of 100 messages resident.
    expect(character.chats[0].message).toHaveLength(OPEN_PAGE);
    expect(isSqlWindowPartial(character.chats[0])).toBe(true);
    expect(getSqlWindow(character.chats[0])?.hasOlder).toBe(true);

    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      // Larger than the whole history costs, so the walk stops only at the
      // start of the conversation.
      budgetTokens: OPENED * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
    });
    flushSync();

    expect(result.holdsNewestEnd).toBe(true);
    expect(result.historySatisfied).toBe(true);
    expect(result.reachedStartOfHistory).toBe(true);
    expect(result.resident).toBe(OPENED);
    // The whole conversation is resident, in order, with no duplicates.
    const ids = residentIds(character.chats[0]);
    expect(ids).toHaveLength(OPENED);
    expect(new Set(ids).size).toBe(OPENED);
    expect(ids[0]).toBe("chat-opened-msg-0000");
    expect(ids.at(-1)).toBe(`chat-opened-msg-${String(OPENED - 1).padStart(4, "0")}`);
    expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
  }, 120_000);

  // ── The prompt gets the history it needs, and not more ──────────────────

  it("loads the history the token budget asks for, not 40 messages and not everything", async () => {
    const character = await openChat("chat-budget");
    expect(character.chats[0].message).toHaveLength(OPEN_PAGE);

    // Room for 200 of the 600 messages.
    const budgetTokens = 200 * TOKENS_PER_MESSAGE;
    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens,
      measure,
      pageSize: 100,
    });
    flushSync();

    expect(result.holdsNewestEnd).toBe(true);
    expect(result.historySatisfied).toBe(true);
    // Not the 40 the chat opened on...
    expect(result.resident).toBeGreaterThan(OPEN_PAGE);
    // ...at least what the budget can spend...
    expect(result.measuredTokens).toBeGreaterThanOrEqual(budgetTokens);
    expect(await measure(character.chats[0].message)).toBeGreaterThanOrEqual(budgetTokens);
    // ...and not the whole 600-message history, which is what windowing exists
    // to avoid.
    expect(result.resident).toBeLessThan(LONG);
    expect(result.reachedStartOfHistory).toBe(false);

    // The resident slice is still the newest end of the conversation: the
    // prompt truncates from the OLDEST end, so the messages that must be there
    // are the last ones.
    const ids = residentIds(character.chats[0]);
    expect(ids.at(-1)).toBe(`chat-budget-msg-${String(LONG - 1).padStart(4, "0")}`);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120_000);

  // ── The measurement this change exists for ──────────────────────────────

  /**
   * The 1200-message conversation, through the real server, at the real budget.
   *
   * The pre-bound walk stopped when the resident history was worth the whole
   * request budget, which on this chat is 740 messages after 7 page requests --
   * 2.3x `MAX_RESIDENT_MESSAGES`, re-tokenised on every subsequent send, to
   * build a prompt whose history `selectNarrativeWorkingMessages` caps at
   * twelve. Both figures are asserted below, so the "after" numbers are
   * measured against a reproduced "before" rather than a remembered one.
   */
  describe("what a 1200-message conversation actually loads", () => {
    /** The `resolvePromptHistoryBound` result for a given configuration. */
    function boundFor(options: {
      risuBardSettings?: Record<string, unknown>;
      globalLore?: any[];
      loreScanDepth?: number;
    }) {
      const character = {
        chaId: "measure",
        chatPage: 0,
        globalLore: options.globalLore ?? [],
        loreSettings: options.loreScanDepth === undefined ? undefined : { scanDepth: options.loreScanDepth },
        chats: [{ id: "chat-measure", localLore: [], message: [], risuBardSettings: options.risuBardSettings }],
      } as any;
      return resolvePromptHistoryBound(
        character,
        character.chats[0],
        { loreBookDepth: 5, maxContext: 4_000 } as any,
      );
    }

    it("loaded 740 of them before this change, at the budget alone", async () => {
      const character = await openChat("chat-measure");
      expect(character.chats[0].message).toHaveLength(OPEN_PAGE);

      // No `targetMessages`: exactly the v0.3.17 behaviour, still reachable and
      // still what an unboundable configuration falls back to.
      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        measure,
        pageSize: 100,
      });
      flushSync();

      expect(result.resident).toBe(740);
      expect(result.requests).toBe(7);
      expect(result.targetMessages).toBeUndefined();
      // The number this whole change is about: the memory bound, suspended.
      expect(result.resident).toBeGreaterThan(MAX_RESIDENT_MESSAGES * 2);
    }, 120_000);

    it("loads 40 of them at default settings, in no requests at all", async () => {
      const character = await openChat("chat-measure");
      // Twelve turns of working set and twelve of recent-memory projection
      // each reach `12 x 2 + 1 = 25` messages (each turn's char message and
      // the user message before it, plus the user message being sent). The
      // raw guess at the slots holding them is `25 + 8 = 33`, the lorebook
      // scan depth is 5, and the larger of those is under the 40 a chat opens
      // on, so the floor is the target. The 40 already resident satisfy it
      // before the first page request: zero requests, which is the figure
      // this feature was published on. A multiplier on the guess -- the
      // `25 x 2 + 8 = 58` of the previous round -- would put one 18-message
      // page on every chat's first send.
      const bound = boundFor({});
      expect(bound.targetMessages).toBe(OPEN_PAGE);
      expect(bound.targetEnabledMessages).toBe(25);

      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        measure,
        pageSize: 100,
      });
      flushSync();

      expect(result.resident).toBe(OPEN_PAGE);
      expect(result.requests).toBe(0);
      expect(result.historySatisfied).toBe(true);
      expect(result.holdsNewestEnd).toBe(true);
      // Not one message was tokenised to decide that: the message-count test
      // settles it before the measure is ever called.
      expect(result.measuredTokens).toBe(0);
      expect(character.chats[0].message).toHaveLength(40);
      expect(residentIds(character.chats[0]).at(-1))
        .toBe(`chat-measure-msg-${String(MEASURED - 1).padStart(4, "0")}`);
    }, 120_000);

    it("loads what a heavy lorebook scans, and stops there", async () => {
      const character = await openChat("chat-measure");
      const bound = boundFor({
        loreScanDepth: 20,
        globalLore: [
          { comment: "deep", key: "brackwater", content: "@@scan_depth 150\ndeep entry", mode: "normal", insertorder: 100, alwaysActive: false, secondkey: "", selective: false },
        ],
      });
      // The scan depth is a RAW term -- it slices resident slots, not visible
      // messages -- so it takes no headroom: `max(25 + 8, 150) = 150`.
      expect(bound.targetMessages).toBe(150);

      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        measure,
        pageSize: 100,
      });
      flushSync();

      // Exactly the scan's reach, not a round hundred past it: the last page is
      // sized to what is still missing. From 40 resident: 110 missing, one
      // full page of 100 to 140, then a page of 10 to 150. Two requests.
      expect(result.resident).toBe(150);
      expect(result.requests).toBe(2);
      expect(result.resident).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
      // The newest end is still the newest end, and the slice is contiguous.
      const ids = residentIds(character.chats[0]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.at(-1)).toBe(`chat-measure-msg-${String(MEASURED - 1).padStart(4, "0")}`);
      expect(ids[0]).toBe(`chat-measure-msg-${String(MEASURED - 150).padStart(4, "0")}`);
      expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
    }, 120_000);

    it("loads what a heavy narrative working set needs, and stops there", async () => {
      const character = await openChat("chat-measure");
      // A hundred TURNS of working set reach `100 x 2 + 1 = 201` messages of
      // an alternating history, plus the fixed eight of disabled headroom:
      // 209, inside the residency bound.
      const bound = boundFor({
        risuBardSettings: { risuBardResponseMessageCount: 100 },
      });
      expect(bound.targetMessages).toBe(209);
      expect(bound.targetEnabledMessages).toBe(201);

      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        measure,
        pageSize: 100,
      });
      flushSync();

      // From 40 resident: 169 missing, a full page of 100 to 140, then a page
      // of 69 to 209. Two requests, and not one slot past the target.
      expect(result.resident).toBe(209);
      expect(result.requests).toBe(2);
      // The deliberately heavy case still sits inside the residency bound,
      // which is the property that was lost.
      expect(result.resident).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
    }, 120_000);

    it("clamps a hostile configuration to the residency bound rather than past it", async () => {
      const character = await openChat("chat-measure");
      // Two hundred turns reach `200 x 2 + 1 = 401` messages, `401 + 8 = 409`
      // slots: more resident than this application is willing to hold, so
      // both targets clamp to the ceiling. (Excluding user messages from the
      // working set used to be what made a configuration hostile; it no longer
      // moves the reach at all, because the user filter runs on the slice the
      // turn walk has already selected -- `narrativeContext.ts:619` -- and
      // `resolvePromptHistoryBound` reads the turn count alone.)
      const bound = boundFor({
        risuBardSettings: { risuBardResponseMessageCount: 200 },
      });
      expect(bound.targetMessages).toBe(MAX_RESIDENT_MESSAGES);
      expect(bound.targetEnabledMessages).toBe(MAX_RESIDENT_MESSAGES);

      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        measure,
        pageSize: 100,
      });
      flushSync();

      // At the bound and not one message past it -- the last page is sized to
      // what is still missing, so paging cannot overshoot into a trim. From 40
      // resident: full pages to 140 and 240, then the 80 of headroom left
      // under the ceiling. Three requests.
      expect(result.resident).toBe(MAX_RESIDENT_MESSAGES);
      expect(result.requests).toBe(3);
      expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
    }, 120_000);

    it("keeps the budget as a ceiling: a huge target never outspends it", async () => {
      const character = await openChat("chat-measure");
      // A target well past what 65,000 tokens can hold. The budget stops the
      // walk first, so this can never load more than the old behaviour did.
      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: 100 * REAL_TOKENS_PER_MESSAGE,
        targetMessages: MAX_RESIDENT_MESSAGES,
        measure,
        pageSize: 100,
      });
      flushSync();

      expect(result.resident).toBeLessThan(MAX_RESIDENT_MESSAGES);
      expect(result.measuredTokens).toBeGreaterThanOrEqual(100 * REAL_TOKENS_PER_MESSAGE);
      expect(result.historySatisfied).toBe(true);
      expect(result.holdsNewestEnd).toBe(true);
    }, 120_000);

    it("never loads less than the window a chat opens on", async () => {
      const character = await openChat("chat-measure");
      // Even asked for one message, the floor in `resolvePromptHistoryBound`
      // means a send never shrinks the window a trigger script or a
      // `{{history}}` token sees. Passed straight through here to show the
      // preload itself does not add a floor of its own -- the bound owns it.
      // One turn reaches `1 x 2 + 1 = 3` messages; the confirmed-memory turn
      // (4) is then the largest enabled term, `4 + 8 = 12` slots, the scan
      // depth is 5, and `max(12, 5)` is floored to the opening page.
      const bound = boundFor({
        risuBardSettings: { risuBardResponseMessageCount: 1, risuBardRecentMessageCount: 1 },
      });
      expect(bound.targetMessages).toBe(OPEN_PAGE);
      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        measure,
        pageSize: 100,
      });
      expect(result.resident).toBe(OPEN_PAGE);
    }, 120_000);

    it("keeps paging when disabled messages make the raw target optimistic", async () => {
      // `targetMessages` is a guess -- "the visible requirement plus eight" --
      // made before a single message is loaded. On a chat with two of every
      // three recent messages disabled it holds a third of what it guesses,
      // and the prompt would have been built from a fraction of the working
      // set the reader configured, with nothing to say so. The walk checks
      // the guess against the messages it actually holds.
      //
      // Thirty turns, not sixty: sixty turns reach 121 visible messages, which
      // at one visible in three is 363 slots, past the 320 ceiling -- that is
      // the scenario below, not this one. Thirty reach `30 x 2 + 1 = 61`,
      // `61 + 8 = 69` slots to guess at, and 61 visible take about 183 slots
      // of this chat: past the opening page, inside the ceiling.
      const bound = boundFor({ risuBardSettings: { risuBardResponseMessageCount: 30 } });
      expect(bound.targetMessages).toBe(69);
      expect(bound.targetEnabledMessages).toBe(61);

      const visible = (chat: Chat) =>
        (chat.message ?? []).filter((message) => message.disabled !== true).length;

      // The guess alone, which is what shipped before this: short. With no
      // visible target the ceiling defaults to the raw target, so the one
      // page is sized to the 29 missing and the walk ends at 69 slots, which
      // hold 23 visible messages (indices 1131..1197 divisible by three).
      const guessOnly = await openChat("chat-disabled");
      await ensurePromptHistoryResident({
        character: guessOnly,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        measure,
        pageSize: 100,
      });
      flushSync();
      expect(guessOnly.chats[0].message).toHaveLength(69);
      expect(visible(guessOnly.chats[0])).toBe(23);
      expect(visible(guessOnly.chats[0])).toBeLessThan(61);

      // The guess plus the check on what actually arrived.
      const character = await openChat("chat-disabled");
      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        targetEnabledMessages: bound.targetEnabledMessages,
        residentCeiling: bound.residentCeiling,
        measure,
        pageSize: 100,
      });
      flushSync();

      expect(visible(character.chats[0])).toBeGreaterThanOrEqual(61);
      // Two requests, because the page size is scaled by the visible density
      // already observed rather than by the raw shortfall -- sizing it by the
      // shortfall filled a third of the gap each time and took ten. The walk,
      // step by step (`nextPageSize` in `promptHistoryPreload.ts`):
      //
      //   40 resident, 13 visible (1161..1197 by three). Missing is the larger
      //   of `69 - 40 = 29` and `61 - 13 = 48`; at density 13/40 the 48 want
      //   `ceil(48 / 0.325) = 148` slots, capped at the 100-message page.
      //   140 resident, 46 visible (1062..1197). Missing `61 - 46 = 15`; at
      //   density 46/140 that is `ceil(15 x 140 / 46) = 46` slots.
      //   186 resident, 62 visible (1014..1197). 62 >= 61: satisfied.
      expect(result.resident).toBe(186);
      expect(visible(character.chats[0])).toBe(62);
      expect(result.requests).toBe(2);
      // Still inside the residency bound, and still the newest end.
      expect(result.resident).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
      expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
      expect(residentIds(character.chats[0]).at(-1))
        .toBe(`chat-disabled-msg-${String(MEASURED - 1).padStart(4, "0")}`);
    }, 120_000);

    it("stops at the residency ceiling even when the visible target is unreachable", async () => {
      // Almost everything disabled: no resident count this application is
      // willing to hold contains the visible messages this asks for. Two
      // hundred turns reach `200 x 2 + 1 = 401` visible messages, which the
      // ceiling clamps to 320 (both targets: `401 + 8 = 409` raw, 401
      // visible), and 320 slots of this chat hold about 107 visible. The
      // ceiling is the answer, not an unbounded walk.
      const bound = boundFor({ risuBardSettings: { risuBardResponseMessageCount: 200 } });
      expect(bound.targetEnabledMessages).toBe(MAX_RESIDENT_MESSAGES);
      expect(bound.targetMessages).toBe(MAX_RESIDENT_MESSAGES);

      const character = await openChat("chat-disabled");
      const result = await ensurePromptHistoryResident({
        character,
        chatIndex: 0,
        budgetTokens: MODEL_PRESET_BUDGET,
        targetMessages: bound.targetMessages,
        targetEnabledMessages: bound.targetEnabledMessages,
        residentCeiling: bound.residentCeiling,
        measure,
        pageSize: 100,
      });
      flushSync();

      // From 40 resident: full pages to 140 and 240 (the density-scaled
      // request wants far more than a page each time), then the 80 slots of
      // headroom left under the ceiling. Three requests, and the visible
      // count never reaches the target -- the ceiling is what stops the walk.
      expect(result.resident).toBe(MAX_RESIDENT_MESSAGES);
      expect(result.requests).toBe(3);
      expect((character.chats[0].message ?? []).filter((message) => message.disabled !== true).length)
        .toBeLessThan(bound.targetEnabledMessages!);
      expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
    }, 120_000);
  });

  it("reports progress while it pages, so a long walk is not a silent pause", async () => {
    const character = await openChat("chat-progress", 100);
    const seen: Array<{ phase: string; resident: number; total: number; requests: number }> = [];

    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: TRIMMING * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
      onProgress: (progress) => seen.push({ ...progress }),
    });
    flushSync();

    // Several round trips, and the reader is told about each of them before it
    // is made -- not once at the end.
    expect(result.requests).toBeGreaterThan(2);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((progress) => progress.total === TRIMMING)).toBe(true);
    // Monotonic and finishing at the real resident count, so a progress
    // display built from it cannot go backwards or stop short.
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index].resident).toBeGreaterThanOrEqual(seen[index - 1].resident);
      expect(seen[index].requests).toBeGreaterThanOrEqual(seen[index - 1].requests);
    }
    expect(seen.at(-1)!.resident).toBe(result.resident);
  }, 120_000);

  it("refuses when the send is aborted mid-walk instead of generating from what arrived", async () => {
    const character = await openChat("chat-aborted", 100);
    const controller = new AbortController();

    await expect(ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: TRIMMING * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
      onProgress: (progress) => {
        if (progress.requests >= 1) controller.abort();
      },
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/);

    // Partially loaded, and still honestly marked partial.
    expect(isSqlWindowPartial(character.chats[0])).toBe(true);
    expect(character.chats[0].message.length).toBeLessThan(TRIMMING);
    // The pin is released even on the abort path.
    expect(isResidencyPinned("chat-aborted")).toBe(false);
  }, 120_000);

  // ── A chat that is already whole ────────────────────────────────────────

  it("sends a chat that is already at the true start of its history without loading anything", async () => {
    const character = await openChat("chat-short");
    expect(character.chats[0].message).toHaveLength(SHORT);
    expect(isSqlWindowPartial(character.chats[0])).toBe(false);

    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: 1_000_000,
      measure,
      pageSize: 100,
    });

    expect(result.requests).toBe(0);
    expect(result.reachedStartOfHistory).toBe(true);
    expect(result.historySatisfied).toBe(true);
    expect(result.resident).toBe(SHORT);
  }, 120_000);

  it("does nothing for a chat that was never windowed", async () => {
    // No hydration window at all: a legacy full-load chat, or a non-SQL
    // backend. `chat.message` is the whole history by construction.
    const plain = {
      chaId: CHARACTER_ID,
      chatPage: 0,
      chats: [{ id: "chat-unwindowed", message: [{ role: "user", data: "hi", chatId: "a" }] }],
    } as unknown as character;

    const result = await ensurePromptHistoryResident({
      character: plain,
      chatIndex: 0,
      budgetTokens: 1_000_000,
      measure,
      pageSize: 100,
    });
    expect(result.requests).toBe(0);
    expect(result.historySatisfied).toBe(true);
    expect(result.holdsNewestEnd).toBe(true);
  });

  // ── A failed load refuses; it never sends short ─────────────────────────

  it("rejects rather than generating from a short history when a page fails to load", async () => {
    const character = await openChat("chat-failing");
    const residentBefore = residentIds(character.chats[0]);
    expect(residentBefore).toHaveLength(OPEN_PAGE);

    // A storage whose OLDER pages fail. The newest page (no `before` cursor)
    // still works, so the chat opens exactly as it does in the app and only
    // the paging this preload drives is broken -- the real shape of a dropped
    // connection mid-scrollback.
    const client = await createClient(port, password);
    activeStorage.current = new NodeSqliteStorage((input, init) => {
      const url = String(input);
      if (url.includes("/messages?") && url.includes("before=")) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return client.fetch(url, init);
    });

    await expect(ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: OPENED * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
      // The rejection is the transport failure itself, surfaced verbatim --
      // not a local "no older messages" fallback that would look the same from
      // outside while meaning something entirely different.
    })).rejects.toThrow(/SQL message page failed \(500\)/);

    // Nothing was invented and nothing was lost: the chat is exactly as the
    // reader last saw it, and it is still marked partial so no other
    // completeness reader is fooled either.
    expect(residentIds(character.chats[0])).toEqual(residentBefore);
    expect(isSqlWindowPartial(character.chats[0])).toBe(true);
  }, 120_000);

  it("rejects when the walk fails partway, rather than sending the pages that did arrive", async () => {
    const character = await openChat("chat-halfway", 100);
    const residentBefore = character.chats[0].message.length;

    // The first older page succeeds, the second does not: a connection that
    // drops in the middle of the walk, which is the shape that would otherwise
    // leave a plausible-looking but short history behind.
    let olderPages = 0;
    const client = await createClient(port, password);
    activeStorage.current = new NodeSqliteStorage((input, init) => {
      const url = String(input);
      if (url.includes("/messages?") && url.includes("before=")) {
        olderPages += 1;
        if (olderPages > 1) return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return client.fetch(url, init);
    });

    await expect(ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: TRIMMING * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
    })).rejects.toThrow(/SQL message page failed \(500\)/);
    flushSync();

    // One page did land -- so this really is the partial-failure case and not
    // the everything-failed one -- and it is still honestly marked partial.
    expect(olderPages).toBeGreaterThan(1);
    expect(character.chats[0].message.length).toBeGreaterThan(residentBefore);
    expect(character.chats[0].message.length).toBeLessThan(TRIMMING);
    expect(isSqlWindowPartial(character.chats[0])).toBe(true);
    expect((character.chats[0] as any).messagesFullyLoaded).toBe(false);
  }, 120_000);

  it("rejects when the trimmed newest end cannot be restored", async () => {
    const character = await openChat("chat-restore-fails", 100);

    // Trim the newest end the way scroll paging does.
    let guard = 0;
    while (getSqlWindow(character.chats[0])?.hasOlder === true) {
      await loadOlderChatMessages(character, 0, 100);
      flushSync();
      if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
    }
    expect(hasNewerSqlMessages(character.chats[0])).toBe(true);
    const residentBefore = character.chats[0].message.map((message) => message.chatId);

    // The newest page (no `before` cursor) is what the restore asks for, and it
    // is the one that fails now.
    const client = await createClient(port, password);
    activeStorage.current = new NodeSqliteStorage((input, init) => {
      const url = String(input);
      if (url.includes("/messages?") && !url.includes("before=")) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return client.fetch(url, init);
    });

    await expect(ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: 50 * TOKENS_PER_MESSAGE,
      measure,
      pageSize: 100,
    })).rejects.toThrow();

    // Refused with the chat exactly as it was, and still missing its newest
    // end -- so no reply can be appended after the hole.
    expect(character.chats[0].message.map((message) => message.chatId)).toEqual(residentBefore);
    expect(hasNewerSqlMessages(character.chats[0])).toBe(true);
  }, 120_000);

  it("rejects when the chat it was loading is gone by the time a page lands", async () => {
    const character = await openChat("chat-vanishing", 100);

    await expect(ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: TRIMMING * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
      onProgress: (progress) => {
        // The chat is deleted underneath the walk. There is no history left to
        // be whole, so there is nothing to generate from either.
        if (progress.requests >= 1) character.chats.splice(0, character.chats.length);
      },
    })).rejects.toThrow(/hydration window|does not hold the newest end/);
  }, 120_000);

  // ── The newest end comes back on its own ────────────────────────────────

  it("restores a newest end that residency trimming released, with no user action", async () => {
    const character = await openChat("chat-restore", 100);

    // Walk all the way back, which is what the reader does with the scrollback
    // and what crosses MAX_RESIDENT_MESSAGES. Unpinned, so the trimmer runs.
    let guard = 0;
    while (getSqlWindow(character.chats[0])?.hasOlder === true) {
      await loadOlderChatMessages(character, 0, 100);
      flushSync();
      if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
    }
    expect(hasNewerSqlMessages(character.chats[0])).toBe(true);
    const newestId = `chat-restore-msg-${String(TRIMMING - 1).padStart(4, "0")}`;
    expect(residentIds(character.chats[0])).not.toContain(newestId);

    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      // Small: the restored newest page already covers it, so this test is
      // about the restore leg alone.
      budgetTokens: 50 * TOKENS_PER_MESSAGE,
      measure,
      pageSize: 100,
    });
    flushSync();

    expect(result.holdsNewestEnd).toBe(true);
    expect(result.historySatisfied).toBe(true);
    expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
    expect(residentIds(character.chats[0])).toContain(newestId);
    expect(residentIds(character.chats[0]).at(-1)).toBe(newestId);
  }, 120_000);

  // ── Residency trimming must not eat the tail the send appends to ────────

  it("does not release the newest end while loading a history past MAX_RESIDENT_MESSAGES", async () => {
    const character = await openChat("chat-bound", 100);

    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      budgetTokens: TRIMMING * TOKENS_PER_MESSAGE * 2,
      measure,
      pageSize: 100,
    });
    flushSync();

    // The load genuinely crossed the bound -- otherwise this test would pass
    // for the wrong reason.
    expect(result.resident).toBeGreaterThan(MAX_RESIDENT_MESSAGES);
    expect(result.resident).toBe(TRIMMING);
    expect(result.reachedStartOfHistory).toBe(true);
    // ...and the tail the reply is about to be appended to is still there.
    expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
    expect(result.holdsNewestEnd).toBe(true);
    const ids = residentIds(character.chats[0]);
    expect(ids.at(-1)).toBe(`chat-bound-msg-${String(TRIMMING - 1).padStart(4, "0")}`);
    expect(new Set(ids).size).toBe(ids.length);
    // The pin is released again, so ordinary scroll paging trims as before.
    expect(isResidencyPinned("chat-bound")).toBe(false);
  }, 120_000);

  it("still trims when nothing is pinned, so the test above is measuring the pin", async () => {
    const character = await openChat("chat-untrimmed-control", 100);

    let guard = 0;
    while (getSqlWindow(character.chats[0])?.hasOlder === true) {
      await loadOlderChatMessages(character, 0, 100);
      flushSync();
      if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
    }

    // The same walk over the same history, without a pin: the trimmer fires,
    // the resident slice stays inside the bound, and the newest end is gone.
    expect(character.chats[0].message.length).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
    expect(hasNewerSqlMessages(character.chats[0])).toBe(true);
  }, 120_000);

  it("refuses to trim a chat that has a generation in flight", async () => {
    const character = await openChat("chat-generating", 100);
    const newestId = `chat-generating-msg-${String(TRIMMING - 1).padStart(4, "0")}`;

    // `chatGenKey` is the chat's own id; the send registers under it before it
    // touches the message array.
    startGeneration("chat-generating", "generation-1");
    expect(isResidencyPinned("chat-generating")).toBe(true);
    try {
      let guard = 0;
      while (getSqlWindow(character.chats[0])?.hasOlder === true) {
        await loadOlderChatMessages(character, 0, 100);
        flushSync();
        if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
      }
      expect(character.chats[0].message.length).toBeGreaterThan(MAX_RESIDENT_MESSAGES);
      expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
      expect(residentIds(character.chats[0]).at(-1)).toBe(newestId);
    } finally {
      endGeneration("chat-generating");
    }
    expect(isResidencyPinned("chat-generating")).toBe(false);
  }, 120_000);

  // ── The runtime marks survive the paging, and nothing is written ───────

  it("leaves the canonical positions and the hydration window consistent, and writes nothing", async () => {
    const character = await openChat("chat-marks", 100);

    // What storage held before the preload. Read through the real page API, so
    // this is the persisted history, not a copy of the fixture.
    const before = await storage.loadChatMessageReversePage("chat-marks", undefined, 1);

    const result = await ensurePromptHistoryResident({
      character,
      chatIndex: 0,
      // Stop on the budget rather than at the start of history, so the window
      // is checked while it is still legitimately partial.
      budgetTokens: 200 * TOKENS_PER_MESSAGE,
      measure,
      pageSize: 100,
    });
    flushSync();

    const chat = character.chats[0];
    const window = getSqlWindow(chat)!;
    const messages = chat.message;

    // Every resident message carries a canonical position, and they are in
    // strictly ascending persisted order with no gaps introduced by the walk.
    const positions = messages.map((message) => getSqlPosition(message));
    expect(positions.every((position) => Number.isSafeInteger(position))).toBe(true);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
    }
    expect(positions.at(-1)! - positions[0]!).toBe(messages.length - 1);

    // The window still describes the same history, and still describes it as
    // partial -- so export, backup, merge and the idle audit keep seeing a
    // partial history exactly as they did before the send loaded anything.
    expect(window.total).toBe(TRIMMING);
    expect(window.hasNewer).toBe(false);
    expect(window.hasOlder).toBe(true);
    expect(isSqlWindowPartial(chat)).toBe(true);
    expect((chat as any).messagesFullyLoaded).toBe(false);
    // `nextBefore` is the boundary for the next page back: the position of the
    // oldest resident message, so a later scroll continues exactly where the
    // preload stopped rather than re-reading or skipping.
    expect(window.nextBefore).toBe(positions[0]);
    expect(window.nextPosition).toBeGreaterThanOrEqual(positions.at(-1)! + 1);
    expect(result.reachedStartOfHistory).toBe(false);

    // Nothing was marked for writing by reading.
    for (const message of messages) {
      expect(isSqlMessageDirty("chat-marks", message.chatId!)).toBe(false);
    }
    // And storage is byte-for-byte the history it was: same count, same newest
    // message, same next position.
    const after = await storage.loadChatMessageReversePage("chat-marks", undefined, 1);
    expect(after.total).toBe(before.total);
    expect(after.nextPosition).toBe(before.nextPosition);
    expect(after.messages[0].chatId).toBe(before.messages[0].chatId);
    expect(after.messages[0].data).toBe(before.messages[0].data);
  }, 120_000);

  /**
   * The window between the preload's first request and the point where `sendChat`
   * re-reads the selection out of `DBState`.
   *
   * Driven against real hydrated chats rather than object literals: what the
   * predicate compares -- `chaId`, `chatPage`, and the chat's `id` -- are exactly
   * the fields the hydrator fills in, and a literal that happened to differ from
   * a hydrated chat in one of them is the shape of fixture this codebase has been
   * bitten by before.
   */
  describe("the chat a preload was run for", () => {
    /** A character holding two real chats, both opened the way the app opens them. */
    async function openTwoChats(): Promise<character> {
      const db = $state({
        characters: [{
          chaId: CHARACTER_ID,
          chatPage: 0,
          chats: [
            { id: "chat-opened", name: "Chat 0", note: "", localLore: [], message: [] as any[], _placeholder: true, messagesLoaded: false },
            { id: "chat-budget", name: "Chat 1", note: "", localLore: [], message: [] as any[], _placeholder: true, messagesLoaded: false },
          ],
        }],
      });
      const character = db.characters[0] as unknown as character;
      await ensureChatMessageWindow(character, 0, OPEN_PAGE);
      flushSync();
      await ensureChatMessageWindow(character, 1, OPEN_PAGE);
      flushSync();
      return character;
    }

    it("is unmoved when the reader stayed where they were", async () => {
      const character = await openTwoChats();
      const target = capturePromptPreloadTarget(character, 0, character.chats[0]);
      expect(promptPreloadTargetMoved(target, character)).toBe(false);
    }, 120_000);

    it("has moved when the reader switched to another chat of the same character", async () => {
      const character = await openTwoChats();
      const target = capturePromptPreloadTarget(character, 0, character.chats[0]);
      // Exactly what the sidebar does while the pages are in the air. Chat 1 was
      // never preloaded: it is sitting on the 40 messages it opened with.
      character.chatPage = 1;
      expect(character.chats[1].message.length).toBe(OPEN_PAGE);
      expect(isSqlWindowPartial(character.chats[1])).toBe(true);
      expect(promptPreloadTargetMoved(target, character)).toBe(true);
    }, 120_000);

    it("has moved when the reader opened a different character", async () => {
      const character = await openTwoChats();
      const target = capturePromptPreloadTarget(character, 0, character.chats[0]);
      const other = { chaId: "someone-else", chatPage: 0, chats: [{ id: "chat-opened" }] } as unknown as character;
      expect(promptPreloadTargetMoved(target, other)).toBe(true);
    }, 120_000);

    it("has moved when the slot still exists but now holds a different chat", async () => {
      const character = await openTwoChats();
      const target = capturePromptPreloadTarget(character, 0, character.chats[0]);
      // A deletion shifts the chat list under a selection that never changed.
      character.chats.splice(0, 1);
      expect(character.chatPage).toBe(0);
      expect(promptPreloadTargetMoved(target, character)).toBe(true);
    }, 120_000);

    it("does not refuse a legacy chat that has no id yet", async () => {
      // `ensureNarrativeSessionChatId` assigns one later in `sendChat`, so a chat
      // can legitimately reach the preload without one. Refusing those would
      // block sends that have done nothing wrong.
      const legacy = { chaId: CHARACTER_ID, chatPage: 0, chats: [{ message: [] }] } as unknown as character;
      const target = capturePromptPreloadTarget(legacy, 0, legacy.chats[0]);
      expect(target.chatId).toBeUndefined();
      expect(promptPreloadTargetMoved(target, legacy)).toBe(false);
    });

    it("has moved when there is no selected character at all", async () => {
      const character = await openTwoChats();
      const target = capturePromptPreloadTarget(character, 0, character.chats[0]);
      expect(promptPreloadTargetMoved(target, undefined)).toBe(true);
    }, 120_000);
  });
});

describe("the residency pin", () => {
  afterEach(() => {
    endAllGenerations();
    resetResidencyPinsForTesting();
  });

  it("counts, so two holders cannot unpin each other", () => {
    beginResidencyPin("chat-a");
    beginResidencyPin("chat-a");
    endResidencyPin("chat-a");
    expect(isResidencyPinned("chat-a")).toBe(true);
    endResidencyPin("chat-a");
    expect(isResidencyPinned("chat-a")).toBe(false);
  });

  it("survives the end/restart churn of auto-continue under one key", () => {
    startGeneration("chat-b", "generation-1");
    // Auto-continue: end and immediately restart under the same key.
    endGeneration("chat-b", { keepPendingAbort: true });
    startGeneration("chat-b", "generation-2");
    expect(isResidencyPinned("chat-b")).toBe(true);
    endGeneration("chat-b");
    expect(isResidencyPinned("chat-b")).toBe(false);
  });

  it("is not double-released by a duplicate endGeneration", () => {
    beginResidencyPin("chat-c");
    startGeneration("chat-c", "generation-1");
    endGeneration("chat-c");
    endGeneration("chat-c");
    // The preload's own pin is still held; only the generation's was released.
    expect(isResidencyPinned("chat-c")).toBe(true);
    endResidencyPin("chat-c");
    expect(isResidencyPinned("chat-c")).toBe(false);
  });

  it("releases every live entry that endAllGenerations clears", () => {
    startGeneration("chat-d", "generation-1");
    startGeneration("chat-e", "generation-2", "background");
    endAllGenerations();
    expect(isResidencyPinned("chat-d")).toBe(false);
    // A background job still holds the chat: its poll loop will append to it.
    expect(isResidencyPinned("chat-e")).toBe(true);
  });
});
