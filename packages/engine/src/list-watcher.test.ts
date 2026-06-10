import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LiveListSnapshot, LiveListSnapshotRow, UpsertLiveListSnapshot } from './list-store.js';
import { FsrWatcher, type LivePatch, type WatcherConfig } from './watcher.js';

const config: WatcherConfig = {
  pollIntervalMs: 50,
  promoteAfterHits: 1,
  patchDebounceSecs: 0,
  purgeAfterSeconds: 60,
  scheduledInvalidations: [],
  idleEvictSecs: 0,
  idleThresholdSecs: 60
};

class FakeListStore {
  snapshots = new Map<string, LiveListSnapshot>();
  events: string[] = [];
  failMarkFresh = false;

  constructor(private readonly timeline: string[]) {}

  async upsertSnapshot(input: UpsertLiveListSnapshot) {
    this.snapshots.set(key(input.route, input.name), {
      ...input,
      htmlPath: input.htmlPath ?? null,
      jsonPath: input.jsonPath ?? null,
      stale: false,
      version: 0,
      lastPatchedAt: new Date(),
      debounceSecs: input.debounceSecs ?? null,
      revalidateSecs:
        input.revalidateSecs === false ? 0 : input.revalidateSecs ?? null,
    });
  }

  async fetchStaleLists() {
    return [...this.snapshots.values()].filter((snapshot) => snapshot.stale);
  }

  async getSnapshot(route: string, name: string) {
    return this.snapshots.get(key(route, name)) ?? null;
  }

  async markFresh(route: string, name: string, rows: LiveListSnapshotRow[]) {
    if (this.failMarkFresh) throw new Error('persist failed');
    this.events.push(`persist:${route}:${name}`);
    this.timeline.push(`persist:${route}:${name}`);
    const snapshot = this.snapshots.get(key(route, name));
    if (!snapshot) throw new Error('missing snapshot');
    snapshot.rows = rows;
    snapshot.stale = false;
  }
}

class FakeRedis {
  html = new Map<string, string>();
  json = new Map<string, any>();
  published: any[] = [];

  async getHtml(route: string) {
    return this.html.get(route) ?? null;
  }
  async getJson(route: string) {
    return this.json.get(route) ?? null;
  }
  async setHtml(route: string, html: string) {
    this.html.set(route, html);
  }
  async setJson(route: string, json: any) {
    this.json.set(route, structuredClone(json));
  }
  async publishPatch(patch: any) {
    this.published.push(patch);
  }
}

class FakeStore {
  lists: FakeListStore;

  constructor(timeline: string[]) {
    this.lists = new FakeListStore(timeline);
  }

  async fetchStaleSlots() {
    return [];
  }

  async invalidateDepKey(depKey: string) {
    for (const snapshot of this.lists.snapshots.values()) {
      if (snapshot.dependsOn.includes(depKey)) {
        snapshot.stale = true;
      }
    }
  }

  async executeLiveListQuery<T>(
    query: (ctx: { sql?: unknown; signal?: AbortSignal }) => Promise<T[]> | T[],
    signal?: AbortSignal
  ) {
    const rows = await query({ sql: 'fake-sql', signal });
    if (!Array.isArray(rows)) throw new Error('Live.list query must return an array');
    return rows;
  }
}

async function runTests() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-list-watcher-'));
  const htmlPath = path.join(tempDir, 'index.html');
  const jsonPath = path.join(tempDir, 'index.json');
  const timeline: string[] = [];
  const store = new FakeStore(timeline);
  const watcher = new FsrWatcher(store as any, null, config);
  const events: string[] = [];
  const patches: LivePatch[] = [];
  watcher.getEmitter().on('patch', (patch: LivePatch) => {
    events.push(`emit:${patch.kind}:${patch.kind === 'list' ? patch.op : 'scalar'}`);
    timeline.push(`emit:${patch.kind}:${patch.kind === 'list' ? patch.op : 'scalar'}`);
    patches.push(patch);
  });

  const initialRows = [
    { id: 'a', title: 'Alpha', status: 'old' },
    { id: 'b', title: 'Beta', status: 'same' },
    { id: 'd', title: 'Delta', status: 'same' }
  ];
  const initialHtml = [
    '<ul data-kiln-list="todos">',
    '<li data-kiln-key="a"><span data-kiln-field="title">Alpha</span><span data-kiln-field="status">old</span></li>',
    '<li data-kiln-key="b"><span data-kiln-field="title">Beta</span><span data-kiln-field="status">same</span></li>',
    '<li data-kiln-key="d"><span data-kiln-field="title">Delta</span><span data-kiln-field="status">same</span></li>',
    '</ul>'
  ].join('');

  await fs.writeFile(htmlPath, initialHtml);
  await fs.writeFile(jsonPath, JSON.stringify({ todos: initialRows }));

  let nextRows = [
    { id: 'd', title: 'Delta', status: 'same' },
    { id: 'b', title: 'Beta', status: 'updated' },
    { id: 'c', title: 'Gamma', status: 'new' }
  ];

  await watcher.registerLiveList(
    {
      route: '/todos',
      name: 'todos',
      dependsOn: ['todo_events'],
      keyOf: (row: any) => row.id,
      query: () => nextRows,
      renderRows: async (rows: any[]) =>
        new Map(
          rows.map((row) => [
            row.id,
            `<li data-kiln-key="${row.id}"><span data-kiln-field="title">${row.title}</span><span data-kiln-field="status">${row.status}</span></li>`
          ])
        )
    },
    {
      route: '/todos',
      name: 'todos',
      dependsOn: ['todo_events'],
      rows: initialRows.map((row) => ({
        key: row.id,
        data: row,
        html: initialHtml.match(new RegExp(`<li data-kiln-key="${row.id}">.*?</li>`))?.[0] ?? ''
      })),
      htmlPath,
      jsonPath
    }
  );

  assert.equal(watcher.hasRegisteredRoute('/todos'), true);
  store.lists.snapshots.get(key('/todos', 'todos'))!.stale = true;
  await watcher.runOnce();

  assert.deepEqual(
    patches.map((patch: any) => patch.op),
    ["remove", "insert", "move", "replace-row"],
  );
  assert.equal(events[0], 'emit:list:remove');
  assert.equal(store.lists.events[0], 'persist:/todos:todos');
  assert.equal(timeline[0], 'persist:/todos:todos');

  const patchedHtml = await fs.readFile(htmlPath, "utf8");
  assert.equal(patchedHtml, initialHtml);

  const patchedJson = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  assert.deepEqual(patchedJson.todos, nextRows);
  assert.deepEqual(
    store.lists.snapshots.get(key('/todos', 'todos'))!.rows.map((row) => row.key),
    ['d', 'b', 'c']
  );

  patches.length = 0;
  events.length = 0;
  timeline.length = 0;
  store.lists.events.length = 0;
  store.lists.snapshots.get(key('/todos', 'todos'))!.stale = true;
  await watcher.runOnce();
  assert.equal(store.lists.events.length, 1);
  assert.equal(patches.length, 0);
  assert.equal(store.lists.snapshots.get(key('/todos', 'todos'))!.stale, false);

  store.lists.events.length = 0;
  timeline.length = 0;
  const beforeDuplicateHtml = await fs.readFile(htmlPath, 'utf8');
  const beforeDuplicateJson = await fs.readFile(jsonPath, 'utf8');
  nextRows = [
    { id: 'b', title: 'One', status: 'duplicate' },
    { id: 'b', title: 'Two', status: 'duplicate' }
  ];
  store.lists.snapshots.get(key('/todos', 'todos'))!.stale = true;

  await watcher.runOnce();

  assert.equal(store.lists.events.length, 0);
  assert.equal(patches.length, 0);
  assert.equal(await fs.readFile(htmlPath, 'utf8'), beforeDuplicateHtml);
  assert.equal(await fs.readFile(jsonPath, 'utf8'), beforeDuplicateJson);
  assert.equal(store.lists.snapshots.get(key('/todos', 'todos'))!.stale, true);

  nextRows = [
    { id: 'd', title: 'Delta', status: 'same' },
    { id: 'b', title: 'Beta', status: 'persist-failure' },
    { id: 'c', title: 'Gamma', status: 'new' }
  ];
  store.lists.failMarkFresh = true;
  patches.length = 0;
  const beforePersistFailureHtml = await fs.readFile(htmlPath, 'utf8');
  const beforePersistFailureJson = await fs.readFile(jsonPath, 'utf8');
  await watcher.runOnce();
  assert.equal(await fs.readFile(htmlPath, 'utf8'), beforePersistFailureHtml);
  assert.equal(await fs.readFile(jsonPath, 'utf8'), beforePersistFailureJson);
  assert.equal(patches.length, 0);
  assert.equal(store.lists.snapshots.get(key('/todos', 'todos'))!.stale, true);
  store.lists.failMarkFresh = false;

  watcher.unregisterRoute('/todos');
  assert.equal(watcher.hasRegisteredRoute('/todos'), false);

  const isolatedStore = new FakeStore([]);
  const isolatedWatcher = new FsrWatcher(isolatedStore as any, null, config);
  const isolatedPatches: any[] = [];
  isolatedWatcher.getEmitter().on('patch', (patch) => isolatedPatches.push(patch));
  await isolatedWatcher.registerLiveList(
    {
      route: '/multi',
      name: 'first',
      dependsOn: ['first_events'],
      keyOf: (row: any) => row.id,
      query: () => [{ id: '1', value: 'updated' }],
      renderRows: async () =>
        new Map([['1', '<li data-kiln-key="1"><span data-kiln-field="value">updated</span></li>']])
    },
    {
      route: '/multi',
      name: 'first',
      dependsOn: ['first_events'],
      rows: [{ key: '1', data: { id: '1', value: 'old' }, html: '<li>old</li>' }]
    }
  );
  await isolatedWatcher.registerLiveList(
    {
      route: '/multi',
      name: 'second',
      dependsOn: ['second_events'],
      keyOf: (row: any) => row.id,
      query: () => {
        throw new Error('second list should not execute');
      },
      renderRows: async () => new Map()
    },
    {
      route: '/multi',
      name: 'second',
      dependsOn: ['second_events'],
      rows: [
        {
          key: '2',
          data: { id: '2', value: 'unchanged' },
          html: '<li>unchanged</li>'
        }
      ]
    }
  );
  isolatedStore.lists.snapshots.get(key('/multi', 'first'))!.stale = true;
  await isolatedWatcher.runOnce();
  assert.deepEqual(
    isolatedPatches.map((patch) => patch.list),
    ['first']
  );
  assert.equal((isolatedStore.lists.snapshots.get(key('/multi', 'second'))!.rows[0].data as any).value, 'unchanged');

  const registrationStore = new FakeStore([]);
  const registrationWatcher = new FsrWatcher(registrationStore as any, null, config);
  const registrationPatches: any[] = [];
  registrationWatcher.getEmitter().on('patch', (patch) => registrationPatches.push(patch));
  const registrationTarget = {
    route: '/registration',
    name: 'contacts',
    dependsOn: ['contact_events'],
    keyOf: (row: any) => row.id,
    query: () => [],
    renderRows: async () => new Map()
  };
  await registrationWatcher.registerLiveList(registrationTarget, {
    route: '/registration',
    name: 'contacts',
    dependsOn: ['contact_events'],
    rows: [{ key: '1', data: { id: '1', name: 'Ada' }, html: '<li data-kiln-key="1">Ada</li>' }]
  });
  await registrationWatcher.registerLiveList(registrationTarget, {
    route: '/registration',
    name: 'contacts',
    dependsOn: ['contact_events'],
    rows: []
  });
  assert.deepEqual(
    registrationPatches.map((patch) => patch.op),
    ['remove']
  );

  const derivedStore = new FakeStore([]);
  const derivedWatcher = new FsrWatcher(derivedStore as any, null, config);
  const derivedPatches: any[] = [];
  derivedWatcher.getEmitter().on('patch', (patch) => derivedPatches.push(patch));
  await derivedWatcher.registerLiveList(
    {
      route: '/derived',
      name: 'contacts',
      dependsOn: ['contact_events'],
      keyOf: (row: any) => row.id,
      query: () => [{ id: '1', role: 'Director' }],
      renderRows: async () =>
        new Map([
          ['1', '<li data-kiln-key="1" data-search="director"><span data-kiln-field="role">Director</span></li>']
        ])
    },
    {
      route: '/derived',
      name: 'contacts',
      dependsOn: ['contact_events'],
      rows: [
        {
          key: '1',
          data: { id: '1', role: '' },
          html: '<li data-kiln-key="1" data-search=""><span data-kiln-field="role"></span></li>'
        }
      ]
    }
  );
  derivedStore.lists.snapshots.get(key('/derived', 'contacts'))!.stale = true;
  await derivedWatcher.runOnce();
  assert.deepEqual(
    derivedPatches.map((patch) => patch.op),
    ['replace-row']
  );
  assert.ok(derivedPatches[0].html.includes('data-search="director"'));

  const redisHtmlPath = path.join(tempDir, 'redis.html');
  const redisJsonPath = path.join(tempDir, 'redis.json');
  const redisInitialHtml =
    '<ul data-kiln-list="todos"><li data-kiln-key="1"><span data-kiln-field="status">old</span></li></ul>';
  const redisInitialJson = { todos: [{ id: '1', status: 'old' }] };
  await fs.writeFile(redisHtmlPath, redisInitialHtml);
  await fs.writeFile(redisJsonPath, JSON.stringify(redisInitialJson));
  const redisStore = new FakeStore([]);
  const redis = new FakeRedis();
  redis.html.set('/redis', redisInitialHtml);
  redis.json.set('/redis', redisInitialJson);
  const redisWatcher = new FsrWatcher(redisStore as any, redis as any, config);
  await redisWatcher.registerLiveList(
    {
      route: '/redis',
      name: 'todos',
      dependsOn: ['todo_events'],
      keyOf: (row: any) => row.id,
      query: () => [{ id: '1', status: 'fresh' }],
      renderRows: async () => new Map([['1', '<li data-kiln-key="1"><span data-kiln-field="status">fresh</span></li>']])
    },
    {
      route: '/redis',
      name: 'todos',
      dependsOn: ['todo_events'],
      rows: [{ key: '1', data: { id: '1', status: 'old' }, html: '<li>old</li>' }],
      htmlPath: redisHtmlPath,
      jsonPath: redisJsonPath
    }
  );
  redisStore.lists.snapshots.get(key("/redis", "todos"))!.stale = true;
  await redisWatcher.runOnce();
  assert.equal(redis.html.get("/redis"), redisInitialHtml);
  assert.equal(redis.json.get("/redis").todos[0].status, "fresh");
  assert.equal(redis.published.length, 1);

  const emptyHtmlPath = path.join(tempDir, 'empty.html');
  const emptyJsonPath = path.join(tempDir, 'empty.json');
  await fs.writeFile(emptyHtmlPath, '<body data-kiln-live="/empty" data-kiln-live-lists="todos"><ul></ul></body>');
  await fs.writeFile(emptyJsonPath, JSON.stringify({ todos: [] }));
  const emptyStore = new FakeStore([]);
  const emptyWatcher = new FsrWatcher(emptyStore as any, null, config);
  await emptyWatcher.registerLiveList(
    {
      route: '/empty',
      name: 'todos',
      dependsOn: ['todo_events'],
      keyOf: (row: any) => row.id,
      query: () => [{ id: '1', title: 'First' }],
      renderRows: async () => new Map([['1', '<li data-kiln-key="1"><span data-kiln-field="title">First</span></li>']])
    },
    {
      route: '/empty',
      name: 'todos',
      dependsOn: ['todo_events'],
      rows: [],
      htmlPath: emptyHtmlPath,
      jsonPath: emptyJsonPath
    }
  );
  emptyStore.lists.snapshots.get(key('/empty', 'todos'))!.stale = true;
  await emptyWatcher.runOnce();
  assert.equal(emptyWatcher.hasRegisteredRoute("/empty"), true);

  await fs.rm(tempDir, { recursive: true });
  console.log('FsrWatcher Live.list tests passed');
}

function key(route: string, name: string) {
  return `${route}\0${name}`;
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
