/**
 * Grok Build runs the hooks in ~/.claude/settings.json as well as its own, so on a machine wired
 * for both hosts every Grok event reaches Claude Code's entry points too. These drive the real
 * lifecycle declarations with Grok's envelope and assert which ones do any work.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawConfig } from "./core/config";
import { runHook } from "./core/hook";
import { runRetainHook } from "./core/retain-hook";
import { runSessionStartHook } from "./core/session-start";
import { HOOK_HARNESSES } from "./harness/hook-lifecycle";

let stdin = "";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) =>
      target === 0 ? stdin : (actual.readFileSync as (...a: unknown[]) => unknown)(target, ...rest),
  };
});

let rawConfig: RawConfig = {};
vi.mock("./core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/config")>();
  return { ...actual, loadConfig: () => actual.resolveConfig(rawConfig) };
});

let root: string;
let sessionId: string;

/** Grok 1.0.41's envelope: its camelCase fields plus Claude-named aliases. */
const grokEvent = (hookEventName: string, hook_event_name: string, extra = {}) =>
  JSON.stringify({
    hookEventName,
    hook_event_name,
    sessionId,
    session_id: sessionId,
    cwd: root,
    workspaceRoot: `${root}/`,
    permissionMode: "auto",
    ...extra,
  });

const promptClient = () =>
  vi.fn(() => ({
    reflect: async () => "",
    listPages: async () => ({ items: [] }),
    searchKnowledgePages: async () => [],
    recallObservations: async () => [],
    knowledgePagesSupported: false,
  }));

const quietly = async (run: () => Promise<void>) => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run();
  } finally {
    write.mockRestore();
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hs-grok-compat-"));
  execFileSync("git", ["init", "-q", root]);
  sessionId = `sess-grok-${basename(root)}`;
  rawConfig = { autoSeed: false, autoUpdate: false };
  vi.stubEnv("HINDSIGHT_DIAG_FILE", join(root, "diag.log"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code hooks run by Grok", () => {
  it("the prompt hook recalls under Claude Code", async () => {
    const makeClient = promptClient();
    stdin = grokEvent("user_prompt_submit", "UserPromptSubmit", { prompt: "which parser?" });
    await quietly(() => runHook(HOOK_HARNESSES["claude-code"].prompt, makeClient as never));
    expect(makeClient).toHaveBeenCalled();
  });

  it("the prompt hook stays silent when Grok's hook runner started it", async () => {
    vi.stubEnv("GROK_HOOK_EVENT", "user_prompt_submit");
    const makeClient = promptClient();
    stdin = grokEvent("user_prompt_submit", "UserPromptSubmit", { prompt: "which parser?" });
    await quietly(() => runHook(HOOK_HARNESSES["claude-code"].prompt, makeClient as never));
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("the session-start hook stays silent when Grok's hook runner started it", async () => {
    vi.stubEnv("GROK_HOOK_EVENT", "session_start");
    const makeClient = vi.fn();
    stdin = grokEvent("session_start", "SessionStart", { source: "new" });
    await quietly(() =>
      runSessionStartHook(HOOK_HARNESSES["claude-code"].sessionStart, makeClient)
    );
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("the stop hook stays silent when Grok's hook runner started it", async () => {
    vi.stubEnv("GROK_HOOK_EVENT", "stop");
    const makeClient = vi.fn();
    stdin = grokEvent("stop", "Stop", { reason: "end_turn", transcript_path: join(root, "t") });
    await runRetainHook(HOOK_HARNESSES["claude-code"].retain, makeClient);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("leave Grok's own prompt hook running", async () => {
    vi.stubEnv("GROK_HOOK_EVENT", "user_prompt_submit");
    const makeClient = promptClient();
    stdin = grokEvent("user_prompt_submit", "UserPromptSubmit", { prompt: "which parser?" });
    await quietly(() => runHook(HOOK_HARNESSES["grok-build"].prompt, makeClient as never));
    expect(makeClient).toHaveBeenCalled();
  });
});

/** Everything a hook wrote to stdout. */
const captured = async (run: () => Promise<void>): Promise<string> => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run();
    return write.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    write.mockRestore();
  }
};

// Grok hands the model `additionalContext` from tool hooks only: SessionStart is observe-only and
// UserPromptSubmit can only block, so context emitted there never reached the model (#5467).
describe("Grok Build context delivery", () => {
  const grok = HOOK_HARNESSES["grok-build"];
  const toolUse = () => grokEvent("post_tool_use", "PostToolUse", { toolName: "read_file" });

  const GUIDE = "<hindsight_knowledge>";
  const REFRESH = "<hindsight_knowledge_refresh>";
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  const startSession = async (source = "new") => {
    vi.stubEnv("GROK_HOOK_EVENT", "session_start");
    stdin = grokEvent("session_start", "SessionStart", { source });
    return captured(() =>
      runSessionStartHook(grok.sessionStart, () => ({
        listPages: async () => ({ items: [] }),
        listDocumentIds: async () => new Set<string>(),
      }))
    );
  };
  const submitPrompt = async (prompt = "which parser?") => {
    vi.stubEnv("GROK_HOOK_EVENT", "user_prompt_submit");
    stdin = grokEvent("user_prompt_submit", "UserPromptSubmit", { prompt });
    return captured(() => runHook(grok.prompt, promptClient() as never));
  };
  /** What the model receives from the next tool hook ("" when nothing is pending). */
  const useTool = async (): Promise<string> => {
    vi.stubEnv("GROK_HOOK_EVENT", "post_tool_use");
    stdin = toolUse();
    const out = await captured(() => runHook(grok.prompt, promptClient() as never));
    return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
  };

  it("delivers the SessionStart guide once, on the next PostToolUse, without a duplicate refresh", async () => {
    expect(await startSession()).not.toContain("additionalContext");
    expect(await submitPrompt()).not.toContain("additionalContext");

    vi.stubEnv("GROK_HOOK_EVENT", "post_tool_use");
    stdin = toolUse();
    const delivered = JSON.parse(
      await captured(() => runHook(grok.prompt, promptClient() as never))
    );
    expect(delivered.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const context: string = delivered.hookSpecificOutput.additionalContext;
    // The full guide already carries the tool guide and page roster: the first prompt's refresh
    // would only repeat it in the same delivery.
    expect(count(context, GUIDE)).toBe(1);
    expect(count(context, REFRESH)).toBe(0);

    // Delivered once: the next tool call has nothing to hand over, and never builds a client.
    stdin = toolUse();
    const makeClient = promptClient();
    expect(await captured(() => runHook(grok.prompt, makeClient as never))).toBe("");
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("still delivers the scheduled refresh on a later prompt, once the guide has been delivered", async () => {
    await startSession();
    await submitPrompt();
    expect(count(await useTool(), GUIDE)).toBe(1);

    await submitPrompt("and the lexer?");
    const later = await useTool();
    expect(count(later, REFRESH)).toBe(1);
    expect(count(later, GUIDE)).toBe(0);
  });

  it("holds back every refresh while the guide is still waiting for a tool hook", async () => {
    await startSession();
    await submitPrompt();
    await submitPrompt("and the lexer?");
    const context = await useTool();
    expect(count(context, GUIDE)).toBe(1);
    expect(count(context, REFRESH)).toBe(0);
  });

  it("keeps the refresh when SessionStart never ran for the session", async () => {
    await submitPrompt();
    const context = await useTool();
    expect(count(context, REFRESH)).toBe(1);
    expect(count(context, GUIDE)).toBe(0);
  });

  it("re-delivers the guide, still once, when the host starts the session again after a reset", async () => {
    await startSession();
    await submitPrompt();
    await useTool();

    await startSession("compact");
    await submitPrompt("and the lexer?");
    const context = await useTool();
    expect(count(context, GUIDE)).toBe(1);
    expect(count(context, REFRESH)).toBe(0);
  });

  it("installs the prompt entry on PostToolUse; other hosts still emit on the prompt", async () => {
    expect(grok.additionalHooks).toEqual([
      { event: "PostToolUse", entry: "grok-hook.js", timeout: 30 },
    ]);
    stdin = grokEvent("user_prompt_submit", "UserPromptSubmit", { prompt: "which parser?" });
    const out = await captured(() =>
      runHook(HOOK_HARNESSES["claude-code"].prompt, promptClient() as never)
    );
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBeTruthy();
  });
});
