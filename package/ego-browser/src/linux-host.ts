import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code?: number; message?: string; data?: string };
  sessionId?: string;
};

type PendingCommand = {
  resolve: (message: CdpMessage) => void;
  reject: (error: Error) => void;
};

type Space = {
  id: number;
  name: string;
  browserContextId: string;
  ownership: "agent" | "agentDelegatedToUser" | "user";
  activeTargetId?: string;
  state?: string;
};

type SnapshotOptions = {
  scope?: "full_page" | "only_within_viewport" | "subtree";
  root?: number;
  interactiveOnly?: boolean;
  maxResultLength?: number;
};

const HOST_ID_START = 1_000_000_000;
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/**
 * Linux compatibility host for the open-source ego-browser runtime.
 *
 * Ego Lite's desktop application injects this API from its native browser
 * process. The Linux container uses Chromium's remote-debugging pipe instead,
 * keeping the public helper runtime unchanged.
 */
export async function installLinuxChromiumHost(
  target: typeof globalThis = globalThis,
) {
  if (target.ego) {
    throw new Error(
      "cannot install the Linux Chromium host over an ego runtime",
    );
  }

  const dataDir =
    process.env.EGO_BROWSER_DATA_DIR ||
    join(process.env.TMPDIR || "/tmp", `ego-browser-linux-${process.pid}`);
  await mkdir(dataDir, { recursive: true });

  const pipe = new ChromiumPipe(resolveChromiumExecutable(), dataDir);
  const runtime = new LinuxEgoRuntime(pipe);
  pipe.onMessage = (message) => runtime.deliver(message);
  await pipe.start();
  await pipe.command("Browser.getVersion");
  target.ego = runtime as any;

  return async () => {
    if (target.ego === runtime) delete target.ego;
    await pipe.close();
  };
}

class ChromiumPipe {
  readonly #executable: string;
  readonly #dataDir: string;
  #child?: ChildProcess;
  #readBuffer = Buffer.alloc(0);
  #nextId = HOST_ID_START;
  #pending = new Map<number, PendingCommand>();
  onMessage?: (message: CdpMessage) => void;

  constructor(executable: string, dataDir: string) {
    this.#executable = executable;
    this.#dataDir = dataDir;
  }

  async start() {
    const extraArgs = splitShellWords(
      process.env.EGO_BROWSER_CHROMIUM_ARGS || "",
    );
    const child = spawn(
      this.#executable,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-features=Translate",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--remote-debugging-pipe",
        `--user-data-dir=${this.#dataDir}`,
        ...extraArgs,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    this.#child = child;
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (!input || !output) {
      child.kill();
      throw new Error("Chromium did not expose its remote-debugging pipe");
    }
    output.on("data", (chunk: Buffer) => this.#consume(chunk));
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      this.#failAll(
        new Error(
          `Chromium exited${code === null ? "" : ` with code ${code}`}` +
            `${signal ? ` (${signal})` : ""}`,
        ),
      );
    });
  }

  send(message: string) {
    const input = this.#child?.stdio[3] as Writable | null | undefined;
    if (!input || !input.writable) {
      throw new Error("Chromium CDP pipe is not writable");
    }
    input.write(`${message}\0`);
  }

  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpMessage> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    const child = this.#child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await Promise.race([
          this.command("Browser.close"),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      } catch {
        // The browser commonly closes its pipe before acknowledging Browser.close.
      }
    }
    this.#child = undefined;
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  }

  #consume(chunk: Buffer) {
    this.#readBuffer = Buffer.concat([this.#readBuffer, chunk]);
    while (true) {
      const separator = this.#readBuffer.indexOf(0);
      if (separator < 0) return;
      const payload = this.#readBuffer.subarray(0, separator).toString("utf8");
      this.#readBuffer = this.#readBuffer.subarray(separator + 1);
      if (!payload) continue;
      let message: CdpMessage;
      try {
        message = JSON.parse(payload);
      } catch {
        continue;
      }
      const pending =
        message.id === undefined ? undefined : this.#pending.get(message.id);
      if (pending && message.id !== undefined) {
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(cdpError(message.error));
        } else {
          pending.resolve(message);
        }
      } else {
        this.onMessage?.(message);
      }
    }
  }

  #failAll(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

class LinuxEgoRuntime {
  readonly #pipe: ChromiumPipe;
  readonly #spaces = new Map<number, Space>();
  #selectedSpaceId?: number;
  #nextSpaceId = 1;
  onCDPMessage?: (payload: string) => void;
  onSendCDPMessageError?: (message: unknown, errorCode?: string) => void;

  constructor(pipe: ChromiumPipe) {
    this.#pipe = pipe;
  }

  deliver(message: CdpMessage) {
    queueMicrotask(() => this.onCDPMessage?.(JSON.stringify(message)));
  }

  async getBrowserVersion() {
    const response = await this.#pipe.command("Browser.getVersion");
    return {
      currentVersion: String(response.result?.product || "Chromium"),
      updateAvailable: false,
    };
  }

  async listProfiles() {
    return {
      profiles: [{ id: "Default", name: "Container", isDefault: true }],
    };
  }

  async listTaskSpaces() {
    const taskSpaces = await Promise.all(
      [...this.#spaces.values()].map(async (space) => {
        const tabs = await this.#tabs(space);
        return {
          taskId: space.name,
          id: space.id,
          name: space.name,
          createdBy: "agent",
          ownership: space.ownership,
          profileId: "Default",
          profileName: "Container",
          recentTabTitles: tabs
            .map((tab) => tab.title)
            .filter(Boolean)
            .slice(-5),
        };
      }),
    );
    return { taskSpaces };
  }

  async createTaskSpace(name: string, profileId = "Default") {
    if (typeof name !== "string" || !name.trim()) {
      throw invalidArgument("task space name must be a non-empty string");
    }
    if (profileId && profileId !== "Default" && profileId !== "default") {
      return {
        error: "Profile not found",
        error_code: "EGO_PROFILE_NOT_FOUND",
      };
    }
    const context = await this.#pipe.command("Target.createBrowserContext", {
      disposeOnDetach: false,
    });
    const browserContextId = context.result?.browserContextId;
    if (!browserContextId)
      throw new Error("Chromium returned no browser context id");
    const id = this.#nextSpaceId++;
    const space: Space = {
      id,
      name: name.trim(),
      browserContextId,
      ownership: "agent",
    };
    this.#spaces.set(id, space);
    const tab = await this.#pipe.command("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    space.activeTargetId = tab.result?.targetId;
    return this.#descriptor(space);
  }

  useTaskSpace(id: number) {
    if (!Number.isInteger(id))
      throw invalidArgument("task space id must be an integer");
    if (!this.#spaces.has(id)) {
      return {
        error: `Task space not found: ${id}`,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      };
    }
    this.#selectedSpaceId = id;
    return id;
  }

  async claimTaskSpace(id: number, name?: string) {
    const space = this.#spaces.get(id);
    if (!space) {
      return {
        error: `Task space not found: ${id}`,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      };
    }
    if (name !== undefined) space.name = name;
    space.ownership = "agent";
    return this.#descriptor(space);
  }

  async createTab(url: string) {
    if (typeof url !== "string")
      throw invalidArgument("tab URL must be a string");
    const space = this.#controlledSpace();
    const result = await this.#pipe.command("Target.createTarget", {
      url,
      browserContextId: space.browserContextId,
    });
    space.activeTargetId = result.result?.targetId;
    return { targetId: space.activeTargetId };
  }

  async listTabs() {
    const space = this.#controlledSpace();
    return { tabs: await this.#tabs(space) };
  }

  async snapshot(options: SnapshotOptions = {}) {
    const space = this.#controlledSpace();
    const targetId = await this.#activeTarget(space);
    const attached = await this.#pipe.command("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.result?.sessionId;
    if (!sessionId)
      throw new Error("Chromium returned no page session for snapshot");
    try {
      const result = options.root
        ? await this.#pipe.command(
            "Accessibility.getPartialAXTree",
            { backendNodeId: options.root, fetchRelatives: false },
            sessionId,
          )
        : await this.#pipe.command(
            "Accessibility.getFullAXTree",
            {},
            sessionId,
          );
      return formatSnapshot(result.result?.nodes || [], options);
    } finally {
      await this.#pipe
        .command("Target.detachFromTarget", { sessionId })
        .catch(() => {});
    }
  }

  async closeTaskSpace() {
    const space = this.#space();
    await this.#pipe.command("Target.disposeBrowserContext", {
      browserContextId: space.browserContextId,
    });
    this.#spaces.delete(space.id);
    this.#selectedSpaceId = undefined;
    return `${space.id} task space closed.`;
  }

  async completeTaskSpace() {
    const space = this.#space();
    space.ownership = "user";
    return `${space.id} task space completed.`;
  }

  async handOffTaskSpace() {
    const space = this.#space();
    space.ownership = "agentDelegatedToUser";
    return `${space.id} has been handed off to the user.`;
  }

  async takeOverTaskSpace() {
    const space = this.#space();
    space.ownership = "agent";
    return `${space.id} has been taken over by the agent.`;
  }

  async setAgentTaskState(state: string) {
    const space = this.#controlledSpace();
    space.state = state;
    return `${space.id} state updated.`;
  }

  async animationHighlightMouseToPosition(_x: number, _y: number) {
    return `${this.#controlledSpace().id} mouse position updated.`;
  }

  sendCDPMessage(message: string) {
    if (typeof message !== "string")
      throw invalidArgument("CDP message must be a string");
    try {
      const space = this.#controlledSpace();
      const parsed = JSON.parse(message);
      if (
        parsed?.method === "Target.activateTarget" &&
        typeof parsed?.params?.targetId === "string"
      ) {
        space.activeTargetId = parsed.params.targetId;
      }
      this.#pipe.send(message);
    } catch (error) {
      const structured = error as Error & { error_code?: string };
      queueMicrotask(() =>
        this.onSendCDPMessageError?.(
          structured.message,
          structured.error_code || "EGO_CDP_CHANNEL_UNAVAILABLE",
        ),
      );
    }
  }

  async #tabs(space: Space) {
    const result = await this.#pipe.command("Target.getTargets");
    const targets = (result.result?.targetInfos || []).filter(
      (target) =>
        target.type === "page" &&
        target.browserContextId === space.browserContextId,
    );
    if (!targets.some((target) => target.targetId === space.activeTargetId)) {
      space.activeTargetId = targets.at(-1)?.targetId;
    }
    return targets.map((target, index) => ({
      index,
      targetId: target.targetId,
      url: target.url || "",
      title: target.title || "",
      active: target.targetId === space.activeTargetId,
      ...(target.openerId ? { openerId: target.openerId } : {}),
    }));
  }

  async #activeTarget(space: Space) {
    const tabs = await this.#tabs(space);
    const active = tabs.find((tab) => tab.active) || tabs.at(-1);
    if (!active)
      throw egoError("task space has no page", "EGO_WEB_CONTENTS_UNAVAILABLE");
    return active.targetId;
  }

  #descriptor(space: Space) {
    return {
      taskId: space.name,
      id: space.id,
      name: space.name,
      ownership: space.ownership,
    };
  }

  #space() {
    const space =
      this.#selectedSpaceId === undefined
        ? undefined
        : this.#spaces.get(this.#selectedSpaceId);
    if (!space)
      throw egoError("no task space selected", "EGO_TASK_SPACE_NOT_SELECTED");
    return space;
  }

  #controlledSpace() {
    const space = this.#space();
    if (space.ownership !== "agent") {
      throw egoError("manual_takeover", "EGO_TASK_SPACE_USER_IN_CONTROL");
    }
    return space;
  }
}

export function formatSnapshot(nodes: any[], options: SnapshotOptions) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds || []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  const refs: Array<Record<string, unknown>> = [];
  let nextRef = 1;

  const render = (node: any, depth: number): string[] => {
    if (node.role?.value === "InlineTextBox") return [];
    const children = (node.childIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .flatMap((child) => render(child, node.ignored ? depth : depth + 1));
    if (node.ignored) return children;

    const role = normalizeRole(node.role?.value);
    const name =
      typeof node.name?.value === "string" ? node.name.value.trim() : "";
    const backendNodeId = node.backendDOMNodeId;
    const interactive = INTERACTIVE_ROLES.has(role);
    if (options.interactiveOnly && !interactive) return children;
    if (!role && !name) return children;

    let metadata = "";
    if (Number.isSafeInteger(backendNodeId) && role !== "text") {
      const refId = nextRef++;
      metadata = ` [ref=e${refId}]`;
      refs.push({ refId: `e${refId}`, backendNodeId, role, name });
    }
    const label = role || "container";
    const line = `${"  ".repeat(depth)}${label}${name ? ` ${JSON.stringify(name)}` : ""}${metadata}`;
    return [line, ...children];
  };

  let content = roots.flatMap((root) => render(root, 0)).join("\n");
  if (!content.startsWith("root")) content = `root\n${content}`;
  if (options.maxResultLength && content.length > options.maxResultLength) {
    content = content.slice(0, options.maxResultLength);
  }
  return { content, refs };
}

function normalizeRole(value: unknown) {
  if (typeof value !== "string") return "";
  if (value === "RootWebArea") return "root";
  if (value === "StaticText") return "text";
  if (value === "generic" || value === "none") return "container";
  return value.toLowerCase();
}

function resolveChromiumExecutable() {
  const configured = process.env.EGO_BROWSER_CHROMIUM_PATH;
  if (configured) return configured;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(
      "Chromium was not found; set EGO_BROWSER_CHROMIUM_PATH to its executable",
    );
  }
  return executable;
}

function splitShellWords(value: string) {
  return (
    value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => {
      const quote = word[0];
      return (quote === '"' || quote === "'") && word.at(-1) === quote
        ? word.slice(1, -1)
        : word;
    }) || []
  );
}

function cdpError(error: CdpMessage["error"]) {
  return new Error(
    `CDP error ${error?.code ?? "unknown"}: ${error?.message || "unknown error"}` +
      `${error?.data ? ` (${error.data})` : ""}`,
  );
}

function egoError(message: string, code: string) {
  return Object.assign(new Error(message), { error_code: code });
}

function invalidArgument(message: string) {
  return egoError(message, "EGO_INVALID_ARGUMENT");
}
