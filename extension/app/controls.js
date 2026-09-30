// Omarchy control decorators. Both pages keep their native elements as the
// source of truth (popup.js/options.js read `.checked`/`.value` and attach
// `change` listeners to them); this file only wraps/paints around them.
// Native selects are hidden inside `.om-select` shells whose floating menu is
// rebuild from the select's options whenever the DOM mutates (popup.js
// re-populates `formatSelect` after a probe).
(function() {
  "use strict";

  const CHECK_SEL = "label.check > input[type='checkbox']";
  const CARET_FALLBACK = "\u25BE";
  let selectSeq = 0;

  function decorateCheck(input) {
    const label = input.parentElement;
    if (label.classList.contains("om-check")) return;
    label.classList.add("om-check");
    const toggle = document.createElement("span");
    toggle.className = "om-switch-toggle";
    toggle.setAttribute("aria-hidden", "true");
    toggle.innerHTML = '<span class="om-switch-track"></span><span class="om-switch-knob"></span>';
    label.appendChild(toggle);
  }

  function decorateSelect(select) {
    if (select.parentElement && select.parentElement.classList.contains("om-select")) return;
    const wrap = document.createElement("div");
    wrap.className = "om-select";

    const menuId = "om-select-menu-" + ++selectSeq;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "om-select-btn";
    btn.setAttribute("role", "combobox");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-controls", menuId);
    btn.setAttribute("aria-expanded", "false");
    const labelEl = document.createElement("span");
    labelEl.className = "om-select-label";
    const caret = document.createElement("span");
    caret.className = "om-select-caret";
    caret.textContent = CARET_FALLBACK;
    btn.append(labelEl, caret);

    const menu = document.createElement("div");
    menu.className = "om-select-menu";
    menu.id = menuId;
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    select.parentNode.insertBefore(wrap, select);
    wrap.append(btn, menu, select);
    select.classList.add("om-native");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;
    menu.addEventListener("mousedown", (e) => e.preventDefault());

    const rebuild = () => {
      menu.textContent = "";
      [...select.children].forEach((node) => {
        if (node.tagName === "OPTGROUP") {
          const caption = document.createElement("div");
          caption.className = "om-select-group";
          caption.textContent = node.label;
          menu.appendChild(caption);
          const sep = document.createElement("div");
          sep.className = "om-select-sep";
          menu.appendChild(sep);
          [...node.children].forEach((opt) => {
            if (opt.tagName === "OPTION") renderOption(opt);
          });
        } else if (node.tagName === "OPTION") {
          renderOption(node);
        }
      });
      function renderOption(opt) {
        const row = document.createElement("div");
        row.className = "om-select-opt";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", opt.selected ? "true" : "false");
        row.dataset.value = opt.value;
        row.textContent = opt.textContent;
        if (opt.disabled) row.classList.add("disabled");
        if (opt.selected) row.classList.add("selected");
        row.addEventListener("click", () => choose(row));
        menu.appendChild(row);
      }
    };

    const syncLabel = () => {
      const selOpt = select.selectedOptions && select.selectedOptions[0];
      labelEl.textContent = selOpt ? selOpt.textContent : select.getAttribute("placeholder") || "Select\u2026";
    };

    const setActive = (row) => {
      menu.querySelectorAll(".om-select-opt").forEach((r) => r.classList.toggle("active", r === row));
      row.scrollIntoView({ block: "nearest" });
    };

    const optRows = () => [...menu.querySelectorAll(".om-select-opt:not(.disabled)")];

    const pick = (row) => {
      select.value = row.dataset.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      close();
    };

    const choose = (row) => {
      if (row.classList.contains("disabled")) return;
      pick(row);
    };

    const open = () => {
      if (select.disabled) return;
      rebuild();
      syncLabel();
      if (!optRows().length) return;
      const rect = btn.getBoundingClientRect();
      menu.hidden = false;
      const menuH = menu.offsetHeight;
      const menuW = Math.max(rect.width, 190);
      menu.style.width = menuW + "px";
      let left = rect.left;
      left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
      let top;
      if (rect.bottom + 4 + menuH <= window.innerHeight) {
        top = rect.bottom + 4;
      } else {
        top = Math.max(4, rect.top - 4 - menuH);
      }
      menu.style.top = top + "px";
      menu.style.left = left + "px";
      btn.setAttribute("aria-expanded", "true");
      wrap.dataset.open = "true";
      const sel = optRows().find((r) => r.classList.contains("selected")) || optRows()[0];
      if (sel) setActive(sel);
    };

    const close = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      wrap.dataset.open = "false";
    };

    const toggleOpen = () => (menu.hidden ? open() : close());

    btn.addEventListener("click", toggleOpen);

    // Native `change` covers user picks via pick() above and any code that
    // dispatches one after a programmatic .value set (popup/options). The
    // MutationObserver alone can't see IDL property changes on a static option
    // list, so this is what keeps the button label honest.
    select.addEventListener("change", syncLabel);

    // A <label for="…Select"> click focuses the invisible native select
    // (tabIndex -1 keeps it out of the tab order); surface that as the menu
    // opening instead of an invisible focus.
    select.addEventListener("focus", () => {
      if (!btn.disabled) open();
    });

    btn.addEventListener("keydown", (e) => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!menu.hidden && (keys.includes(e.key) || e.key === "Enter" || e.key === "Escape" || e.key === "Tab")) {
        e.preventDefault();
        const rows = optRows();
        if (!rows.length) return;
        if (e.key === "Escape" || e.key === "Tab") {
          close();
          return;
        }
        const cur = menu.querySelector(".om-select-opt.active");
        let idx = cur ? rows.indexOf(cur) : -1;
        if (e.key === "ArrowDown") idx = Math.min(idx + 1, rows.length - 1);
        else if (e.key === "ArrowUp") idx = Math.max(idx - 1, 0);
        else if (e.key === "Home") idx = 0;
        else if (e.key === "End") idx = rows.length - 1;
        else if (e.key === "Enter" && cur) return choose(cur);
        if (rows[idx]) setActive(rows[idx]);
      } else if (menu.hidden && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        open();
      }
    });

    document.addEventListener("click", (e) => {
      if (!menu.hidden && !wrap.contains(e.target)) close();
    });

    const observer = new MutationObserver(() => {
      if (menu.hidden) {
        rebuild();
      }
      syncLabel();
      btn.disabled = select.disabled;
    });
    observer.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "value", "selected"],
    });

    rebuild();
    syncLabel();
    btn.disabled = select.disabled;
  }

  function init() {
    document.querySelectorAll(CHECK_SEL).forEach(decorateCheck);
    document.querySelectorAll("select").forEach(decorateSelect);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();