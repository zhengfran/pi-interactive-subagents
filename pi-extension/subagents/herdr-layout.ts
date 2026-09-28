import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

/** Herdr 0.9 socket API: one newline-delimited JSON request/response per connection. */
type Request = (method: string, params: Record<string, unknown>) => Promise<any>;

async function socketRequest(method: string, params: Record<string, unknown>): Promise<any> {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path || process.env.HERDR_ENV !== "1") throw new Error("No Herdr socket context");
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    let settled = false;
    const finish = (error?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(2000, () => finish(new Error("Herdr layout request timed out")));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error("Herdr layout socket closed without a response")); });
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.length > 1024 * 1024) return finish(new Error("Herdr layout response too large"));
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        const envelope = JSON.parse(text.slice(0, newline));
        if (envelope.error) return finish(new Error(`Herdr ${method}: ${envelope.error.message ?? envelope.error.code}`));
        if (!envelope.result) return finish(new Error(`Herdr ${method}: missing result`));
        finish(undefined, envelope.result);
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ id: randomUUID(), method, params }) + "\n"));
  });
}

let request: Request = socketRequest;
export function __setLayoutRequestForTest__(replacement: Request): () => void {
  const previous = request;
  request = replacement;
  return () => { request = previous; };
}

type Node = { type: "pane"; pane_id?: string } | { type: "split"; direction: string; ratio: number; first: Node; second: Node };
type Change = { path: boolean[]; ratio: number };

function leaves(node: Node): string[] {
  return node.type === "pane" ? (node.pane_id ? [node.pane_id] : []) : [...leaves(node.first), ...leaves(node.second)];
}

/** Only modify the maximal horizontal subtree containing the caller and exclusively owned children. */
export function planEqualWidths(root: Node, caller: string, owned: ReadonlySet<string>, width: number, minWidth = 12, rects?: ReadonlyMap<string, { x: number; width: number }>): Change[] {
  const allowed = new Set([caller, ...owned]);
  const horizontal = (node: Node): boolean => node.type === "pane" ||
    (node.direction === "right" && horizontal(node.first) && horizontal(node.second));
  let group: Node | null = null;
  let groupPath: boolean[] = [];
  function locate(node: Node, path: boolean[]): void {
    const ids = leaves(node);
    if (ids.includes(caller) && ids.length > 1 && ids.every((id) => allowed.has(id))) {
      if (node.type === "split" && horizontal(node)) {
        group = node;
        groupPath = path;
        return;
      }
    }
    if (node.type === "split") {
      if (leaves(node.first).includes(caller)) locate(node.first, [...path, false]);
      else if (leaves(node.second).includes(caller)) locate(node.second, [...path, true]);
    }
  }
  locate(root, []);
  if (!group) return [];
  const groupIds = leaves(group);
  const geometry = groupIds.map((id) => rects?.get(id)).filter((rect): rect is { x: number; width: number } => !!rect);
  if (rects && geometry.length !== groupIds.length) return [];
  if (geometry.length) width = Math.max(...geometry.map((r) => r.x + r.width)) - Math.min(...geometry.map((r) => r.x));
  if (width < groupIds.length * minWidth) return [];
  const changes: Change[] = [];
  function visit(node: Node, path: boolean[]): void {
    if (node.type !== "split" || node.direction !== "right") return;
    const first = leaves(node.first).length;
    const second = leaves(node.second).length;
    if (first && second) {
      const ratio = first / (first + second);
      if (Math.abs(node.ratio - ratio) > 0.0001) changes.push({ path, ratio });
    }
    visit(node.first, [...path, false]);
    visit(node.second, [...path, true]);
  }
  visit(group, groupPath);
  return changes;
}

export async function balanceOwnedPanes(caller: string, owned: ReadonlySet<string>): Promise<void> {
  if (!caller || !owned.size || !process.env.HERDR_SOCKET_PATH || process.env.HERDR_ENV !== "1") return;
  const exported = await request("layout.export", { pane_id: caller });
  const layout = exported.layout;
  if (!layout?.tab_id || layout.zoomed || !layout.root) return;
  const ids = leaves(layout.root as Node);
  // A moved/closed pane must not cause unrelated layout mutations.
  if (!ids.includes(caller) || ![...owned].some((id) => ids.includes(id))) return;
  const snapshot = await request("pane.layout", { pane_id: caller });
  if (snapshot.layout?.tab_id !== layout.tab_id || snapshot.layout?.zoomed) return;
  const paneRects = snapshot.layout.panes as Array<{ pane_id: string; rect: { x: number; width: number } }>;
  // The group width is computed from its actual terminal geometry, not a guessed split ratio.
  const callerRect = paneRects.find((item) => item.pane_id === caller)?.rect;
  if (!callerRect) return;
  // A snapshot gives the tab width; the planner checks conservative total-cell capacity.
  const width = snapshot.layout.area?.width ?? callerRect.width;
  for (const change of planEqualWidths(layout.root, caller, owned, width, 12,
    new Map(paneRects.map((item) => [item.pane_id, item.rect])))) {
    await request("layout.set_split_ratio", { tab_id: layout.tab_id, path: change.path, ratio: change.ratio });
  }
}
