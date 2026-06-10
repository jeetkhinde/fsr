import assert from "node:assert/strict";
import { SQL } from "bun";
import { FsrStore } from "./store.js";

async function runTests() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = new SQL(databaseUrl);
  const store = new FsrStore(sql);
  await store.initialize();

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS kiln_fsr_lists (
      route TEXT NOT NULL,
      name TEXT NOT NULL,
      depends_on TEXT[] NOT NULL DEFAULT '{}',
      rows JSONB NOT NULL DEFAULT '[]',
      stale BOOLEAN NOT NULL DEFAULT false,
      version INTEGER NOT NULL DEFAULT 0,
      html_path TEXT,
      json_path TEXT,
      last_patched_at TIMESTAMP,
      PRIMARY KEY (route, name)
    )
  `);
  await sql.unsafe("DELETE FROM kiln_fsr_lists");

  try {
    await store.lists.upsertSnapshot({
      route: "/todos",
      name: "todos",
      dependsOn: ["todo_events"],
      rows: [
        { key: "2", data: { id: 2, title: "Second" }, html: "<li>Second</li>" },
        { key: "1", data: { id: 1, title: "First" }, html: "<li>First</li>" },
      ],
      htmlPath: "/tmp/todos.html",
      jsonPath: "/tmp/todos.json",
    });

    const snapshot = await store.lists.getSnapshot("/todos", "todos");
    assert.deepEqual(snapshot?.rows.map((row) => row.key), ["2", "1"]);
    assert.deepEqual(snapshot?.dependsOn, ["todo_events"]);
    assert.equal(snapshot?.stale, false);

    assert.deepEqual(await store.invalidateDepKey("todo_events"), ["/todos"]);
    await store.lists.upsertSnapshot({
      route: "/todos",
      name: "todos",
      dependsOn: ["todo_events"],
      rows: [
        { key: "3", data: { id: 3, title: "Premature" }, html: "<li>Premature</li>" },
      ],
    });
    const preserved = await store.lists.getSnapshot("/todos", "todos");
    assert.equal(preserved?.stale, true);
    assert.deepEqual(preserved?.rows.map((row) => row.key), ["2", "1"]);

    const stale = await store.lists.fetchStaleLists();
    assert.equal(stale.length, 1);
    assert.equal(stale[0].name, "todos");
    assert.equal(stale[0].version, 1);

    await store.lists.markFresh("/todos", "todos", [
      { key: "1", data: { id: 1, title: "Updated" }, html: "<li>Updated</li>" },
    ]);
    assert.equal((await store.lists.getSnapshot("/todos", "todos"))?.stale, false);

    await store.lists.upsertSnapshot({
      route: "/multi",
      name: "first",
      dependsOn: [],
      rows: [],
    });
    await store.lists.upsertSnapshot({
      route: "/multi",
      name: "second",
      dependsOn: [],
      rows: [],
    });
    await store.lists.deleteRoute("/multi");
    assert.equal(await store.lists.getSnapshot("/multi", "first"), null);
    assert.equal(await store.lists.getSnapshot("/multi", "second"), null);

    const controller = new AbortController();
    const rows = await store.executeLiveListQuery(
      ({ sql: receivedSql, signal }) => {
        assert.equal(receivedSql, sql);
        assert.equal(signal, controller.signal);
        return [{ id: 1 }];
      },
      controller.signal,
    );
    assert.deepEqual(rows, [{ id: 1 }]);

    await assert.rejects(
      store.executeLiveListQuery(async () => ({ id: 1 }) as any),
      /Live\.list query must return an array/,
    );

    console.log("FsrListStore tests passed");
  } finally {
    await sql.unsafe("DELETE FROM kiln_fsr_lists");
    sql.close();
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
