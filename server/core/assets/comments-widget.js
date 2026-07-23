/*
 * The Scratchwork comments widget: a self-contained browser script injected
 * into every HTML page of a private, comments-enabled project. Plain browser
 * JS by design (it runs inside published pages, like the renderer) — the
 * server embeds it via the generated module comments-widget.generated.ts.
 *
 * It talks to the content-origin comments API at
 * /{project}/__scratchwork/comments; the path-scoped project-access cookie
 * that gated the page itself authenticates every call.
 *
 * Anchoring: each comment stores a list of {selector, x, y} candidates — the
 * clicked element first, then its ancestors, ending with a body-relative
 * fallback. A pin renders at the first selector that still matches, so a
 * republished or dynamic page degrades toward the coarser anchors instead of
 * losing the comment.
 */
(function () {
  "use strict";
  if (window.__scratchworkComments) return;
  window.__scratchworkComments = true;

  var segments = location.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return;
  var project = decodeURIComponent(segments[0]);
  var API_BASE = "/" + encodeURIComponent(project) + "/__scratchwork/comments";
  var PAGE = normalizePage();

  var state = {
    viewer: null,
    comments: [],
    open: false,
    adding: false,
    showResolved: false,
    active: null, // highlighted comment id
    pending: null, // draft anchor {anchors, pageX, pageY}
    editing: null, // comment id with an open edit box
    confirmingDelete: null, // comment id whose delete needs confirming
  };

  // ------------------------------------------------------------------
  // Page identity: the decoded path under the project. The server owns
  // canonicalization (normalizeCommentPage) and applies it to every page
  // value this script sends, so no normalization logic is duplicated here.
  // ------------------------------------------------------------------
  function normalizePage() {
    var rest = "/" + segments.slice(1).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    }).join("/");
    return rest.replace(/\/+/g, "/") || "/";
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  function api(method, path, body) {
    var options = { method: method, headers: {} };
    if (body) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, options).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          throw new Error(data.error || "Request failed (" + res.status + ")");
        });
      }
      return res.json();
    });
  }

  function pageQuery() {
    return "?page=" + encodeURIComponent(PAGE);
  }

  // ------------------------------------------------------------------
  // Anchor capture and resolution
  // ------------------------------------------------------------------
  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function uniqueMatch(selector, el) {
    try {
      var found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el ? selector : null;
    } catch (e) {
      return null;
    }
  }

  function idSelector(el) {
    if (!el.id) return null;
    return uniqueMatch("#" + cssEscape(el.id), el);
  }

  function nthOfType(el) {
    var index = 1;
    var node = el.previousElementSibling;
    while (node) {
      if (node.tagName === el.tagName) index++;
      node = node.previousElementSibling;
    }
    return index;
  }

  /** A selector for el: its unique #id, or a short nth-of-type path from the
   * nearest uniquely-id'd ancestor (or body). Null when nothing stable fits. */
  function selectorFor(el) {
    var direct = idSelector(el);
    if (direct) return direct;
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node !== document.body && node.nodeType === 1 && depth < 6) {
      var anchor = idSelector(node);
      if (anchor && node !== el) {
        var withId = anchor + " > " + parts.join(" > ");
        return withId.length <= 400 ? uniqueMatch(withId, el) : null;
      }
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + nthOfType(node) + ")");
      node = node.parentElement;
      depth++;
    }
    if (node !== document.body) return null;
    var selector = "body > " + parts.join(" > ");
    return selector.length <= 400 ? uniqueMatch(selector, el) : null;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /** Anchor candidates for a click: target, then ancestors, then body. */
  function computeAnchors(target, pageX, pageY) {
    var anchors = [];
    var node = target;
    var depth = 0;
    while (node && node !== document.body && node.nodeType === 1 && depth < 10 && anchors.length < 7) {
      var selector = selectorFor(node);
      if (selector) {
        var rect = node.getBoundingClientRect();
        anchors.push({
          selector: selector,
          x: round2(pageX - (rect.left + window.scrollX)),
          y: round2(pageY - (rect.top + window.scrollY)),
        });
      }
      node = node.parentElement;
      depth++;
    }
    anchors.push({ selector: "body", x: round2(pageX), y: round2(pageY) });
    return anchors;
  }

  /** Page position of a comment: the first anchor whose selector still matches. */
  function anchorPosition(anchors) {
    for (var i = 0; i < anchors.length; i++) {
      var el;
      try { el = document.querySelector(anchors[i].selector); } catch (e) { el = null; }
      if (el) {
        var rect = el.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX + anchors[i].x,
          y: rect.top + window.scrollY + anchors[i].y,
        };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // DOM scaffolding (shadow root keeps page CSS and widget CSS apart)
  // ------------------------------------------------------------------
  var host = document.createElement("div");
  host.setAttribute("data-scratchwork-comments", "");
  host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000;";
  var root = host.attachShadow({ mode: "open" });

  var globalStyle = document.createElement("style");
  globalStyle.textContent = "html.--sw-commenting, html.--sw-commenting * { cursor: crosshair !important; }";

  var style = document.createElement("style");
  style.textContent = "" +
    ":host { all: initial; }" +
    "* { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }" +
    ".fab { position: fixed; right: 20px; bottom: 20px; z-index: 3; display: flex; align-items: center; gap: 7px;" +
    "  border: 1px solid #d4d4d8; background: #ffffff; color: #27272a; border-radius: 999px; padding: 9px 15px;" +
    "  font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.12); }" +
    ".fab:hover { background: #fafafa; }" +
    ".fab .count { background: #4f46e5; color: #fff; border-radius: 999px; min-width: 18px; height: 18px;" +
    "  display: inline-flex; align-items: center; justify-content: center; font-size: 11px; padding: 0 5px; }" +
    ".fab .count.zero { background: #a1a1aa; }" +
    ".panel { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; max-width: 92vw; background: #fff;" +
    "  border-left: 1px solid #e4e4e7; box-shadow: -4px 0 18px rgba(0,0,0,.08); z-index: 2; display: flex;" +
    "  flex-direction: column; }" +
    ".panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #e4e4e7; }" +
    ".panel-head .title { font-size: 14px; font-weight: 700; color: #18181b; margin-right: auto; }" +
    ".icon-btn { border: none; background: none; color: #71717a; font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }" +
    ".icon-btn:hover { background: #f4f4f5; color: #27272a; }" +
    ".btn { border: 1px solid #d4d4d8; background: #fff; color: #27272a; border-radius: 7px; padding: 5px 10px;" +
    "  font-size: 12px; font-weight: 600; cursor: pointer; }" +
    ".btn:hover { background: #fafafa; }" +
    ".btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }" +
    ".btn.primary:hover { background: #4338ca; }" +
    ".btn.danger { color: #b91c1c; border-color: #fca5a5; }" +
    ".btn.danger:hover { background: #fef2f2; }" +
    ".panel-tools { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #f4f4f5; }" +
    ".toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #52525b; cursor: pointer; user-select: none; }" +
    ".list { overflow-y: auto; flex: 1; padding: 8px 10px 16px; }" +
    ".empty { color: #71717a; font-size: 13px; text-align: center; padding: 26px 14px; line-height: 1.5; }" +
    ".card { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; margin: 8px 2px; background: #fff; }" +
    ".card.active { border-color: #4f46e5; box-shadow: 0 0 0 2px rgba(79,70,229,.15); }" +
    ".card.resolved { background: #fafafa; }" +
    ".card.resolved .body { color: #71717a; }" +
    ".card-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }" +
    ".author { font-size: 12px; font-weight: 700; color: #18181b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }" +
    ".time { font-size: 11px; color: #a1a1aa; margin-left: auto; flex-shrink: 0; }" +
    ".resolved-tag { font-size: 10px; font-weight: 700; color: #15803d; background: #f0fdf4; border-radius: 5px; padding: 1px 6px; }" +
    ".body { font-size: 13px; color: #27272a; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }" +
    ".actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }" +
    ".actions .btn { padding: 3px 8px; font-size: 11px; }" +
    "textarea { width: 100%; min-height: 64px; border: 1px solid #d4d4d8; border-radius: 8px; padding: 8px 10px;" +
    "  font-size: 13px; color: #18181b; resize: vertical; outline: none; background: #fff; }" +
    "textarea:focus { border-color: #4f46e5; }" +
    ".pin { position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50% 50% 50% 4px;" +
    "  background: #4f46e5; color: #fff; border: 2px solid #fff; box-shadow: 0 1px 6px rgba(0,0,0,.3); cursor: pointer;" +
    "  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; z-index: 1; }" +
    ".pin.resolved { background: #a1a1aa; }" +
    ".pin.active { transform: scale(1.2); }" +
    ".composer { position: absolute; width: 280px; background: #fff; border: 1px solid #d4d4d8; border-radius: 12px;" +
    "  box-shadow: 0 6px 24px rgba(0,0,0,.16); padding: 10px; z-index: 4; }" +
    ".composer .actions { justify-content: flex-end; }" +
    ".hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); background: #18181b; color: #fff;" +
    "  font-size: 12px; font-weight: 600; border-radius: 999px; padding: 7px 14px; z-index: 5; box-shadow: 0 2px 10px rgba(0,0,0,.25); }";

  var pinsLayer = document.createElement("div");
  var ui = document.createElement("div");
  root.appendChild(style);
  root.appendChild(pinsLayer);
  root.appendChild(ui);

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function esc(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function relativeTime(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    var minutes = Math.round((Date.now() - then) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    if (minutes < 60 * 24) return Math.round(minutes / 60) + "h ago";
    if (minutes < 60 * 24 * 14) return Math.round(minutes / (60 * 24)) + "d ago";
    return new Date(iso).toLocaleDateString();
  }

  function visibleComments() {
    return state.comments.filter(function (comment) {
      return state.showResolved || !comment.resolved;
    });
  }

  function canEdit(comment) {
    if (!state.viewer) return false;
    return state.viewer.canModerate ||
      comment.author.email.toLowerCase() === state.viewer.email.toLowerCase();
  }

  function render() {
    renderPins();
    renderUi();
  }

  function renderPins() {
    pinsLayer.textContent = "";
    var visible = visibleComments();
    for (var i = 0; i < visible.length; i++) {
      (function (comment, index) {
        var position = anchorPosition(comment.anchors);
        if (!position) return;
        var pin = document.createElement("div");
        pin.className = "pin" + (comment.resolved ? " resolved" : "") + (state.active === comment.id ? " active" : "");
        pin.style.left = position.x + "px";
        pin.style.top = position.y + "px";
        pin.textContent = String(index + 1);
        pin.title = comment.author.email;
        pin.addEventListener("click", function (event) {
          event.stopPropagation();
          state.open = true;
          state.active = comment.id;
          render();
          var card = ui.querySelector('[data-comment="' + comment.id + '"]');
          if (card) card.scrollIntoView({ block: "nearest" });
        });
        pinsLayer.appendChild(pin);
      })(visible[i], i);
    }
  }

  function renderUi() {
    ui.textContent = "";
    ui.appendChild(renderFab());
    if (state.adding) ui.appendChild(renderHint());
    if (state.open) ui.appendChild(renderPanel());
    if (state.pending) ui.appendChild(renderComposer());
  }

  function renderFab() {
    var openCount = state.comments.filter(function (comment) { return !comment.resolved; }).length;
    var fab = document.createElement("button");
    fab.className = "fab";
    fab.type = "button";
    fab.innerHTML = "&#128172; Comments <span class=\"count" + (openCount === 0 ? " zero" : "") + "\">" + openCount + "</span>";
    fab.addEventListener("click", function () {
      state.open = !state.open;
      if (!state.open) state.active = null;
      render();
    });
    return fab;
  }

  function renderHint() {
    var hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Click anywhere to leave a comment - Esc to cancel";
    return hint;
  }

  function renderPanel() {
    var panel = document.createElement("div");
    panel.className = "panel";

    var head = document.createElement("div");
    head.className = "panel-head";
    head.innerHTML = "<span class=\"title\">Comments</span>";
    var close = document.createElement("button");
    close.className = "icon-btn";
    close.type = "button";
    close.innerHTML = "&#10005;";
    close.title = "Close";
    close.addEventListener("click", function () {
      state.open = false;
      state.active = null;
      render();
    });
    head.appendChild(close);
    panel.appendChild(head);

    var tools = document.createElement("div");
    tools.className = "panel-tools";
    var add = document.createElement("button");
    add.className = "btn primary";
    add.type = "button";
    add.textContent = "+ Add comment";
    add.addEventListener("click", startAdding);
    tools.appendChild(add);
    var toggle = document.createElement("label");
    toggle.className = "toggle";
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.showResolved;
    checkbox.addEventListener("change", function () {
      state.showResolved = checkbox.checked;
      render();
    });
    toggle.appendChild(checkbox);
    toggle.appendChild(document.createTextNode("Show resolved"));
    tools.appendChild(toggle);
    panel.appendChild(tools);

    var list = document.createElement("div");
    list.className = "list";
    var visible = visibleComments();
    if (visible.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.comments.length === 0
        ? "No comments on this page yet. Click “+ Add comment”, then click anywhere on the page."
        : "All comments on this page are resolved.";
      list.appendChild(empty);
    }
    for (var i = 0; i < visible.length; i++) {
      list.appendChild(renderCard(visible[i], i));
    }
    panel.appendChild(list);
    return panel;
  }

  function renderCard(comment, index) {
    var card = document.createElement("div");
    card.className = "card" + (comment.resolved ? " resolved" : "") + (state.active === comment.id ? " active" : "");
    card.setAttribute("data-comment", comment.id);

    var head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML =
      "<span class=\"author\" title=\"" + esc(comment.author.email) + "\">" + (index + 1) + ". " + esc(comment.author.email) + "</span>" +
      (comment.resolved ? "<span class=\"resolved-tag\">resolved</span>" : "") +
      "<span class=\"time\">" + esc(relativeTime(comment.createdAt)) + "</span>";
    card.appendChild(head);

    if (state.editing === comment.id) {
      var textarea = document.createElement("textarea");
      textarea.value = comment.body;
      card.appendChild(textarea);
      card.appendChild(actionRow([
        button("Save", "btn primary", function () {
          var body = textarea.value.trim();
          if (!body) return;
          state.editing = null;
          update(comment, { body: body });
        }),
        button("Cancel", "btn", function () {
          state.editing = null;
          render();
        }),
      ]));
      return card;
    }

    var body = document.createElement("div");
    body.className = "body";
    body.textContent = comment.body;
    card.appendChild(body);

    var actions = [];
    actions.push(button(comment.resolved ? "Reopen" : "Resolve", "btn", function () {
      update(comment, { resolved: !comment.resolved });
    }));
    if (canEdit(comment)) {
      actions.push(button("Edit", "btn", function () {
        state.editing = comment.id;
        render();
      }));
      if (state.confirmingDelete === comment.id) {
        actions.push(button("Really delete?", "btn danger", function () {
          state.confirmingDelete = null;
          remove(comment);
        }));
      } else {
        actions.push(button("Delete", "btn danger", function () {
          state.confirmingDelete = comment.id;
          render();
        }));
      }
    }
    card.appendChild(actionRow(actions));

    card.addEventListener("click", function () {
      if (state.active === comment.id) return;
      state.active = comment.id;
      render();
      var position = anchorPosition(comment.anchors);
      if (position) {
        window.scrollTo({
          top: Math.max(position.y - window.innerHeight / 2, 0),
          behavior: "smooth",
        });
      }
    });
    return card;
  }

  function button(label, className, onClick) {
    var el = document.createElement("button");
    el.className = className;
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", function (event) {
      event.stopPropagation();
      onClick();
    });
    return el;
  }

  function actionRow(buttons) {
    var row = document.createElement("div");
    row.className = "actions";
    for (var i = 0; i < buttons.length; i++) row.appendChild(buttons[i]);
    return row;
  }

  function renderComposer() {
    var composer = document.createElement("div");
    composer.className = "composer";
    var left = Math.min(state.pending.pageX + 12, window.scrollX + window.innerWidth - 300);
    composer.style.left = Math.max(left, window.scrollX + 8) + "px";
    composer.style.top = (state.pending.pageY + 12) + "px";

    var textarea = document.createElement("textarea");
    textarea.placeholder = "Leave a comment…";
    composer.appendChild(textarea);
    composer.appendChild(actionRow([
      button("Comment", "btn primary", function () {
        var body = textarea.value.trim();
        if (!body) return;
        create(body);
      }),
      button("Cancel", "btn", function () {
        state.pending = null;
        render();
      }),
    ]));
    setTimeout(function () { textarea.focus(); }, 0);
    return composer;
  }

  // ------------------------------------------------------------------
  // Add-comment mode
  // ------------------------------------------------------------------
  function startAdding() {
    if (state.adding) return;
    state.adding = true;
    state.pending = null;
    document.documentElement.classList.add("--sw-commenting");
    document.addEventListener("click", captureClick, true);
    document.addEventListener("keydown", captureEscape, true);
    render();
  }

  function stopAdding() {
    state.adding = false;
    document.documentElement.classList.remove("--sw-commenting");
    document.removeEventListener("click", captureClick, true);
    document.removeEventListener("keydown", captureEscape, true);
  }

  function captureClick(event) {
    if (event.composedPath().indexOf(host) !== -1) return; // widget clicks pass through
    event.preventDefault();
    event.stopPropagation();
    stopAdding();
    var target = event.target && event.target.nodeType === 1 ? event.target : document.body;
    state.pending = {
      anchors: computeAnchors(target, event.pageX, event.pageY),
      pageX: event.pageX,
      pageY: event.pageY,
    };
    render();
  }

  function captureEscape(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    stopAdding();
    render();
  }

  // ------------------------------------------------------------------
  // Mutations
  // ------------------------------------------------------------------
  function fail(error) {
    console.error("[scratchwork comments]", error);
    var hint = document.createElement("div");
    hint.className = "hint";
    hint.style.background = "#b91c1c";
    hint.textContent = String(error && error.message || error);
    ui.appendChild(hint);
    setTimeout(function () { hint.remove(); }, 4000);
  }

  function create(body) {
    var pending = state.pending;
    if (!pending) return;
    api("POST", "", { page: PAGE, body: body, anchors: pending.anchors }).then(function (data) {
      state.pending = null;
      state.viewer = data.viewer;
      state.comments.push(data.comment);
      state.open = true;
      state.active = data.comment.id;
      render();
    }).catch(fail);
  }

  function update(comment, patch) {
    var body = { page: PAGE };
    if (patch.body != null) body.body = patch.body;
    if (patch.resolved != null) body.resolved = patch.resolved;
    api("PATCH", "/" + comment.id, body).then(function (data) {
      state.viewer = data.viewer;
      state.comments = state.comments.map(function (existing) {
        return existing.id === comment.id ? data.comment : existing;
      });
      render();
    }).catch(fail);
  }

  function remove(comment) {
    api("DELETE", "/" + comment.id + pageQuery()).then(function () {
      state.comments = state.comments.filter(function (existing) { return existing.id !== comment.id; });
      if (state.active === comment.id) state.active = null;
      render();
    }).catch(fail);
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  var repositionTimer = null;
  function scheduleReposition() {
    if (repositionTimer != null) return;
    repositionTimer = setTimeout(function () {
      repositionTimer = null;
      renderPins();
    }, 200);
  }

  function boot() {
    document.body.appendChild(host);
    document.head.appendChild(globalStyle);
    api("GET", pageQuery()).then(function (data) {
      state.viewer = data.viewer;
      state.comments = data.comments.slice();
      render();
      window.addEventListener("resize", scheduleReposition);
      // Rendered-Markdown pages build their DOM after load; watch for layout
      // changes so pins track their anchors instead of going stale.
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (!host.contains(mutations[i].target)) {
            scheduleReposition();
            return;
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }).catch(function (error) {
      console.warn("[scratchwork comments] disabled:", error && error.message || error);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
