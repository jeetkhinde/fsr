import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  useSilcrowAtom,
  publishSilcrowAtom,
  useSilcrowPrefetch,
  useSilcrowRoute,
  useSilcrowAction,
  useKilnNamedAction,
  useSilcrowResource,
  useSilcrowForm,
  useSilcrowMutation,
  KilnReactProvider,
  resolveKilnAction,
} from "./hooks.js";
import { submitSilcrow, silcrowSubmitHandler } from "./submit.js";

async function runTests() {
  console.log("Running @kilnjs/react hooks and helpers tests...");

  // Mock global window/Silcrow
  const subscribeCalls: any[] = [];
  const mockSnapshot: Record<string, any> = {
    "route:/cart": { count: 4 },
    "some-atom": "hello-value",
  };

  let published: any = null;
  let prefetchPath = "";
  let submitted: any = null;

  const mockPromise = Promise.resolve("resolved-value") as any;
  mockPromise.status = "fulfilled";
  mockPromise.value = "resolved-value";

  globalThis.window = {
    location: {
      pathname: "/test-path",
    },
    Silcrow: {
      subscribe: (scope, notify) => {
        subscribeCalls.push({ scope, notify });
        return () => {};
      },
      snapshot: (scope) => mockSnapshot[scope],
      publish: (scope, data) => {
        published = { scope, data };
      },
      prefetch: (path) => {
        prefetchPath = path;
        return mockPromise;
      },
      submit: async (url, body, options) => {
        submitted = { url, body, options };
        return {
          ok: true,
          status: 200,
          data: { success: true },
          html: null,
          headers: new Headers(),
        };
      },
    },
  } as any;

  // 1. useSilcrowAtom
  {
    function TestAtom() {
      const val = useSilcrowAtom("some-atom", "fallback");
      return <span>{val}</span>;
    }
    const html = renderToStaticMarkup(<TestAtom />);
    assert.equal(html, "<span>hello-value</span>");
    console.log("✅ useSilcrowAtom renders initial snapshot value");
  }

  // 2. publishSilcrowAtom
  {
    publishSilcrowAtom("some-atom", "new-val");
    assert.deepEqual(published, { scope: "some-atom", data: "new-val" });
    console.log("✅ publishSilcrowAtom delegates to window.Silcrow.publish");
  }

  // 3. useSilcrowRoute
  {
    function TestRoute() {
      const cart = useSilcrowRoute<{ count: number }>("/cart", { count: 0 });
      return <span>Count: {cart.count}</span>;
    }
    const html = renderToStaticMarkup(<TestRoute />);
    assert.equal(html, "<span>Count: 4</span>");
    console.log("✅ useSilcrowRoute maps path to route: prefix");
  }

  // 4. useSilcrowPrefetch
  {
    function TestPrefetch() {
      const promise = useSilcrowPrefetch("/about");
      assert.equal(promise, mockPromise);
      return null;
    }
    renderToStaticMarkup(<TestPrefetch />);
    assert.equal(prefetchPath, "/about");
    console.log("✅ useSilcrowPrefetch returns and triggers prefetch promise");
  }

  // 5. useSilcrowResource
  {
    mockSnapshot["route:/about"] = "resolved-value";
    function TestResource() {
      const val = useSilcrowResource("/about", "fallback");
      return <span>{val}</span>;
    }
    const html = renderToStaticMarkup(<TestResource />);
    assert.equal(html, "<span>resolved-value</span>");
    console.log("✅ useSilcrowResource suspends/resolves with prefetch");
  }

  // 6. submitSilcrow helper
  {
    const action = submitSilcrow<any>("/cart/add", { scope: "cart:add" });
    const fd = new FormData();
    fd.append("qty", "2");
    const result = await action({}, fd);
    assert.deepEqual(submitted, {
      url: "/cart/add",
      body: fd,
      options: {
        method: "POST",
        scope: "cart:add",
        headers: undefined,
        optimistic: undefined,
      },
    });
    assert.deepEqual(result, { success: true });
    console.log("✅ submitSilcrow triggers window.Silcrow.submit");
  }

  // 7. silcrowSubmitHandler helper
  {
    const handler = silcrowSubmitHandler<any, any>("/cart/update", { method: "PATCH" });
    const result = await handler({ item: 123 });
    assert.deepEqual(submitted, {
      url: "/cart/update",
      body: { item: 123 },
      options: {
        method: "PATCH",
        scope: undefined,
        headers: undefined,
        optimistic: undefined,
      },
    });
    assert.deepEqual(result.data, { success: true });
    console.log("✅ silcrowSubmitHandler helper triggers submit with object body");
  }

  // 8. useSilcrowAction
  {
    function TestAction() {
      const [state, action, pending] = useSilcrowAction<any>("/action-url", { val: "initial" });
      return <span>{state.val}</span>;
    }
    const html = renderToStaticMarkup(<TestAction />);
    assert.equal(html, "<span>initial</span>");
    console.log("✅ useSilcrowAction renders initial action state");
  }

  // 9. resolveKilnAction
  {
    assert.equal(resolveKilnAction("sub", "/base"), "/base?/sub");
    assert.equal(resolveKilnAction("sub", "/base?a=1"), "/base?a=1&/sub");
    assert.equal(resolveKilnAction("/absolute", "/base"), "/absolute");
    assert.equal(resolveKilnAction("?/named", "/base"), "?/named");
    console.log("✅ resolveKilnAction resolves relative/absolute named actions");
  }

  // 10. useKilnNamedAction
  {
    function TestNamedAction() {
      const [state] = useKilnNamedAction<any>("testAction", { val: "named-initial" });
      return <span>{state.val}</span>;
    }
    const html = renderToStaticMarkup(
      <KilnReactProvider value={{ actionBase: "/context-base" }}>
        <TestNamedAction />
      </KilnReactProvider>
    );
    assert.equal(html, "<span>named-initial</span>");
    console.log("✅ useKilnNamedAction resolves actionBase from context");
  }

  // 11. useSilcrowForm
  {
    function TestForm() {
      const form = useSilcrowForm("/form-url", {
        ok: false,
        message: "err-msg",
        errors: { foo: "bar" },
      });
      return (
        <div>
          <span id="ok">{String(form.ok)}</span>
          <span id="msg">{form.message}</span>
          <span id="err">{form.errors?.foo}</span>
        </div>
      );
    }
    const html = renderToStaticMarkup(<TestForm />);
    assert.ok(html.includes("false"));
    assert.ok(html.includes("err-msg"));
    assert.ok(html.includes("bar"));
    console.log("✅ useSilcrowForm unpacks form state fields");
  }

  // 12. useSilcrowMutation
  {
    let successCalled = false;
    let successData: any = null;

    function TestMutation() {
      const mut = useSilcrowMutation<any>({
        url: "/mut-url",
        onSuccess: (res) => {
          successCalled = true;
          successData = res.data;
        },
      });

      // Expose mutate trigger
      (globalThis as any).triggerMutate = mut.mutate;

      return (
        <div>
          <span id="data">{mut.data ? JSON.stringify(mut.data) : "null"}</span>
          <span id="pending">{String(mut.pending)}</span>
        </div>
      );
    }

    const html = renderToStaticMarkup(<TestMutation />);
    assert.equal(html, "<div><span id=\"data\">null</span><span id=\"pending\">false</span></div>");

    // Trigger mutate callback
    const promise = (globalThis as any).triggerMutate({ item: 999 });
    await promise;

    assert.ok(successCalled);
    assert.deepEqual(successData, { success: true });
    assert.deepEqual(submitted, {
      url: "/mut-url",
      body: { item: 999 },
      options: {
        method: "POST",
        headers: undefined,
        optimistic: undefined,
      },
    });

    console.log("✅ useSilcrowMutation executes mutation callbacks and submits successfully");
  }

  console.log("🎉 All @kilnjs/react tests passed!");
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
