function initAvatars(root = document) {
  root.querySelectorAll("[data-avatar] img").forEach((image) => {
    if (image.dataset.fallbackBound === "true") return;
    image.dataset.fallbackBound = "true";
    if (image.complete && image.naturalWidth === 0) {
      image.remove();
      return;
    }
    image.addEventListener("error", () => image.remove(), { once: true });
  });
}

function applySearch() {
  const input = document.querySelector("[data-contact-search-input]");
  if (!input) return;
  const searchValue = input.value.trim();
  const query = searchValue.toLowerCase();
  const rows = [...document.querySelectorAll("[data-contact-row]")];
  let visible = 0;

  rows.forEach((row) => {
    const matches = !query || (row.dataset.search || "").includes(query);
    row.hidden = !matches;
    if (matches) visible += 1;
  });

  const url = new URL(location.href);
  if (query) url.searchParams.set("q", searchValue);
  else url.searchParams.delete("q");
  history.replaceState(history.state, "", url);
  document.querySelectorAll("[data-preserve-query]").forEach((link) => {
    const target = new URL(link.getAttribute("href"), location.origin);
    if (query) target.searchParams.set("q", searchValue);
    else target.searchParams.delete("q");
    link.setAttribute("href", `${target.pathname}${target.search}`);
  });

  const status = document.querySelector("[data-search-status]");
  const statusText = `${visible} contact${visible === 1 ? "" : "s"} shown`;
  if (status && status.textContent !== statusText) {
    status.textContent = statusText;
  }
  const empty = document.querySelector("[data-search-empty]");
  if (empty) empty.hidden = visible !== 0;

  let favoriteLabelShown = false;
  let allLabelShown = false;
  rows.forEach((row) => {
    const label = row.querySelector("[data-section-label]");
    if (!label || row.hidden) {
      if (label) label.hidden = true;
      return;
    }
    const favorite = label.dataset.section === "favorites";
    const alreadyShown = favorite ? favoriteLabelShown : allLabelShown;
    label.hidden = alreadyShown;
    if (favorite) favoriteLabelShown = true;
    else allLabelShown = true;
  });
}

function initSearch() {
  const input = document.querySelector("[data-contact-search-input]");
  if (!input || input.dataset.searchBound === "true") return;
  input.dataset.searchBound = "true";
  input.addEventListener("input", applySearch);
  applySearch();
}

function setPending(form, pending) {
  form.classList.toggle("is-pending", pending);
  form.setAttribute("aria-busy", String(pending));
  form.querySelectorAll("button, input, textarea").forEach((control) => {
    control.disabled = pending;
  });
  const submit = form.querySelector("[data-submit-label]");
  if (submit) {
    submit.textContent = pending ? "Saving…" : submit.dataset.submitLabel;
  }
}

function clearErrors(form) {
  form.querySelectorAll(".field__error, .form-error").forEach((error) => {
    if (error.hasAttribute("data-form-message")) {
      error.hidden = true;
      error.textContent = "";
    } else {
      error.remove();
    }
  });
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
  });
}

function renderErrors(form, result) {
  const message = form.querySelector("[data-form-message]");
  if (message) {
    message.hidden = false;
    message.textContent = result.message || "Check the highlighted fields.";
  }
  Object.entries(result.errors || {}).forEach(([name, text]) => {
    if (name === "name") return;
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLElement)) return;
    const errorId = `${name}-error`;
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", errorId);
    const error = document.createElement("small");
    error.id = errorId;
    error.className = "field__error";
    error.textContent = text;
    field.closest(".field")?.append(error);
  });
}

function followRedirect(path) {
  const target = new URL(path, location.origin);
  const query = new URL(location.href).searchParams.get("q");
  if (query) target.searchParams.set("q", query);
  location.assign(target);
}

async function submitForm(form) {
  clearErrors(form);
  const formData = new FormData(form);
  setPending(form, true);
  try {
    const response = await window.Silcrow.submit(form.action, formData, {
      method: "POST",
    });
    const result = response.data;
    if (result?.ok && result.redirect) {
      followRedirect(result.redirect);
      return;
    }
    if (!result?.ok) renderErrors(form, result || {});
  } finally {
    setPending(form, false);
  }
}

async function submitFavorite(form) {
  const button = form.querySelector("button");
  const input = form.querySelector('input[name="favorite"]');
  const next = input.value === "true";
  const formData = new FormData(form);
  const rollback = () => {
    button.textContent = next ? "☆" : "★";
    button.setAttribute("aria-pressed", String(!next));
    button.setAttribute(
      "aria-label",
      next ? "Add to favorites" : "Remove from favorites",
    );
    input.value = String(next);
  };

  button.textContent = next ? "★" : "☆";
  button.setAttribute("aria-pressed", String(next));
  button.setAttribute(
    "aria-label",
    next ? "Remove from favorites" : "Add to favorites",
  );
  button.disabled = true;
  input.value = String(!next);

  try {
    const response = await window.Silcrow.submit(form.action, formData, {
      method: "POST",
    });
    if (!response.ok || !response.data?.ok) rollback();
  } catch {
    rollback();
  } finally {
    button.disabled = false;
  }
}

function initForms() {
  document.querySelectorAll("[data-contact-form]").forEach((form) => {
    if (form.dataset.formBound === "true") return;
    form.dataset.formBound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitForm(form);
    });
  });

  document.querySelectorAll("[data-favorite-form]").forEach((form) => {
    if (form.dataset.formBound === "true") return;
    form.dataset.formBound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitFavorite(form);
    });
  });

  document.querySelectorAll("[data-delete-form]").forEach((form) => {
    if (form.dataset.formBound === "true") return;
    form.dataset.formBound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!window.confirm("Delete this contact? This cannot be undone.")) {
        return;
      }
      setPending(form, true);
      try {
        const response = await window.Silcrow.submit(
          form.action,
          new FormData(form),
          {
            method: "POST",
          },
        );
        if (response.data?.ok && response.data.redirect) {
          followRedirect(response.data.redirect);
        }
      } finally {
        setPending(form, false);
      }
    });
  });
}

function init() {
  initAvatars();
  initSearch();
  initForms();
}

document.addEventListener("DOMContentLoaded", init);
document.addEventListener("silcrow:load", init);

new MutationObserver(() => {
  initAvatars();
  applySearch();
  initForms();
}).observe(document.documentElement, { childList: true, subtree: true });
