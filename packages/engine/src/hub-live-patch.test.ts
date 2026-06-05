import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { createScalarPatch, type ListPatch } from "@kiln/live";
import { fsrHubStream } from "./hub.js";

class FakeWatcher {
  private emitter = new EventEmitter();
  getEmitter() {
    return this.emitter;
  }
}

describe("fsrHubStream live patch payloads", () => {
  it("streams scalar patches as live events and list patches as list-patch events", async () => {
    const watcher = new FakeWatcher();
    const gen = fsrHubStream({
      route: "/tasks",
      slots: ["status", "todos"],
      watcher: watcher as any,
      config: { maxConnections: 10, connectionTtlSecs: 10, keepaliveSecs: 10 },
    });

    const received: any[] = [];
    const streamPromise = (async () => {
      for await (const item of gen) {
        received.push(item);
        if (received.length === 2) break;
      }
    })();

    watcher.getEmitter().emit("patch", createScalarPatch("/tasks", "status", "complete"));
    watcher.getEmitter().emit("patch", {
      kind: "list",
      op: "fields",
      route: "/tasks",
      list: "todos",
      key: "1",
      changes: { status: "complete" },
    } satisfies ListPatch);

    await streamPromise;
    await gen.return(undefined);

    expect(received).toEqual([
      {
        event: "live",
        data: JSON.stringify({ kind: "scalar", route: "/tasks", field: "status", value: "complete" }),
      },
      {
        event: "list-patch",
        data: JSON.stringify({
          kind: "list",
          op: "fields",
          route: "/tasks",
          list: "todos",
          key: "1",
          changes: { status: "complete" },
        }),
      },
    ]);
  });
});
