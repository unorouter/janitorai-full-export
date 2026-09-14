// ==UserScript==
// @name         JanitorAI Full Export
// @namespace    https://unorouter.com/
// @version      1.2.1
// @description  Export your whole JanitorAI account: every chat, the character cards, and every lorebook that is reachable, as one JSON file.
// @author       unorouter
// @match        https://janitorai.com/*
// @match        https://www.janitorai.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=janitorai.com
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/unorouter/janitorai-full-export
// @supportURL   https://github.com/unorouter/janitorai-full-export/issues
// ==/UserScript==

// Export your whole JanitorAI account from your own logged-in session: every
// chat, the character cards behind them, and every lorebook that is reachable.
//
// It runs in YOUR browser because that is the only place the data exists for
// you: janitorai answers 403 to a datacenter address, and a private card or
// lorebook is only ever served to the session that owns the chat.
//
// WHAT IT CANNOT DO, and no tool can:
//   - a card whose creator turned allow_proxy OFF and hid the definition. Both
//     flags closed means the text is never assembled anywhere the browser can
//     see it.
// A private LOREBOOK is recoverable despite answering 404 on its own endpoint,
// because JanitorAI still resolves it into the prompt it assembles for a
// generation. Anything genuinely unreachable is listed at the end rather than
// silently exported as an empty card.

(function () {
  "use strict";

  const runExport = async function (onProgress) {

    const log = (m) => console.log("%c" + m, "color:#6cf");
    const warn = (m) => console.warn("%c" + m, "color:#fc6");

    const cookie = (n) => {
      const m = document.cookie.match(
        new RegExp(
          "(?:^|; )" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)",
        ),
      );
      return m ? decodeURIComponent(m[1]) : "";
    };

    // The session is a SPLIT supabase cookie; localStorage holds no token here.
    let token;
    try {
      const raw = (
        cookie("sb-auth-auth-token.0") + cookie("sb-auth-auth-token.1")
      ).replace("base64-", "");
      token = JSON.parse(atob(raw)).access_token;
    } catch {
      token = null;
    }
    // Thrown, not logged and returned: a silent return leaves the button
    // saying "Done" with no file, which reads as a broken export.
    if (!token) throw new Error("Not logged in to janitorai.com");

    const H = {
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer " + token,
    };
    const get = async (path) => {
      const r = await fetch(path, { headers: H, credentials: "include" });
      return r.ok ? r.json() : null;
    };

    // ---- every character you have chatted with, paginated -------------------
    const characters = [];
    for (let page = 1; ; page++) {
      const j = await get(`/hampter/chats/character-chats?page=${page}`);
      const batch = j?.characters ?? [];
      characters.push(...batch);
      if (!j?.hasMore || batch.length === 0) break;
    }
    if (characters.length === 0) throw new Error("No chats on this account");
    log(`${characters.length} characters`);

    // ---- the assembled prompt, which is where hidden definitions live -------
    // open_ai_mode "proxy" makes JanitorAI build the prompt and hand it back to
    // its own caller instead of forwarding it, so one authenticated POST returns
    // what the card page will not show. The proxy target is never contacted, but
    // the userConfig must be COMPLETE or the server answers 502 while trying to
    // call a provider for real.
    const assembledPrompt = async (characterId, chatId) => {
      const chat = await get("/hampter/chats/" + chatId);
      if (!chat) return null;
      const res = await fetch("/generateAlpha", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          chat: {
            character_id: chat.chat?.character_id ?? characterId,
            id: chat.chat?.id ?? chatId,
            summary: chat.chat?.summary ?? "",
            user_id: chat.chat?.user_id,
          },
          chatMessages: chat.chatMessages ?? [],
          clientPlatform: "web",
          forcedPromptGenerationCacheRefetch: {
            character: false,
            chat: false,
            profile: false,
            script: false,
          },
          generateMode: "NEW",
          generateType: "CHAT",
          profile: chat.personas?.[0] ?? null,
          profiles: chat.personas ?? [],
          userConfig: {
            api: "openai",
            open_ai_mode: "proxy",
            open_ai_reverse_proxy: "https://example.invalid/v1/chat/completions",
            reverseProxyKey: "extract",
            openAiModel: "gpt-4",
            openAIKey: null,
            claudeApiKey: null,
            claudeModel: "",
            claude_jailbreak_prompt: "",
            open_ai_jailbreak_prompt: "",
            proxy_global_prompt: "",
            llm_prompt: "",
            bad_words: [],
            allow_mobile_nsfw: true,
            janitor_router_enabled: false,
            text_streaming: false,
            generation_settings: {
              context_length: 50000,
              enable_reasoning: false,
              enable_reasoning_chat: false,
              enable_router_temperature: false,
              enable_short_responses: false,
              max_new_token: 0,
              prefill_enabled: false,
              prefill_text: "",
              temperature: 1,
            },
          },
        }),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const system = (body?.messages ?? []).find((m) => m.role === "system");
      return system?.content ?? null;
    };

    // A private lorebook 404s on its own endpoint, but its text is still in the
    // assembled prompt, appended AFTER the tagged card blocks with no tag of its
    // own. That tail is the only copy the account can reach. Measured against a
    // real character: 7.3KB of lore in 13 blank-line separated blocks, which is
    // as close to the original entries as this gets. The KEYS are gone for good,
    // because the book was already resolved into flat text before it came back.
    const LORE_MARKER = "</example_dialogs>";
    const lorebookTail = (prompt) => {
      if (!prompt) return null;
      const at = prompt.lastIndexOf(LORE_MARKER);
      if (at < 0) return null;
      const tail = prompt.slice(at + LORE_MARKER.length).trim();
      return tail.length > 200 ? tail : null;
    };

    // Avatars are served as a bare filename off a fixed host, and the file has to
    // carry the BYTES rather than the URL: janitorai can delete or rotate an
    // avatar, and an export that only points at one degrades into a broken image.
    const avatarData = async (name) => {
      if (!name) return null;
      const url = /^https?:/.test(name)
        ? name
        : "https://ella.janitorai.com/bot-avatars/" + name;
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const blob = await r.blob();
        // Skipped rather than inlined past a few MB: one oversized avatar would
        // bloat the export for every reader of the file.
        if (blob.size > 4 * 1024 * 1024) return null;
        const base64 = await new Promise((res) => {
          const fr = new FileReader();
          fr.onloadend = () => res(String(fr.result).split(",")[1] || null);
          fr.onerror = () => res(null);
          fr.readAsDataURL(blob);
        });
        return base64 ? { mimeType: blob.type || "image/png", base64 } : null;
      } catch {
        return null;
      }
    };

    const out = {};
    const skipped = [];
    let chatCount = 0;

    for (const [n, c] of characters.entries()) {
      log(`[${n + 1}/${characters.length}] ${c.name}`);
      if (onProgress) onProgress(n + 1, characters.length, c.name);
      const meta = (await get("/hampter/characters/" + c.character_id)) ?? {};

      // ---- chats and messages ---------------------------------------------
      // Paginated: this endpoint serves TEN chats per page and reports hasMore,
      // so reading the first response only would silently drop every chat past
      // the tenth for anyone who talks to one character a lot.
      const chatRows = [];
      for (let page = 1; ; page++) {
        const list = await get(
          `/hampter/chats/character/${c.character_id}/chats?page=${page}`,
        );
        const batch = list?.chats ?? [];
        chatRows.push(...batch);
        if (!list?.hasMore || batch.length === 0) break;
      }

      const chats = [];
      for (const row of chatRows) {
        const full = await get("/hampter/chats/" + row.id);
        const messages = (full?.chatMessages ?? [])
          // is_main:false is a swipe the user rejected. It is kept rather than
          // dropped so nothing is lost, but it is flagged, because importing one
          // as a normal turn rewrites the conversation: they are timestamped
          // when they were generated, which can be AFTER the turn that replaced
          // them.
          .map((m) => ({
            id: m.id,
            is_bot: m.is_bot,
            is_main: m.is_main !== false,
            message: m.message,
            created_at: m.created_at,
          }))
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        if (messages.length === 0) continue;
        chats.push({
          chat_id: row.id,
          summary: row.summary,
          updated_at: row.updated_at,
          chat_count: messages.length,
          // The persona the user played in THIS chat, which is theirs and so is
          // always readable, unlike the character's own definition.
          persona: full?.personas?.[0]
            ? {
                name: full.personas[0].name,
                appearance: full.personas[0].appearance,
                pronouns: full.personas[0].pronouns,
              }
            : null,
          messages,
        });
        chatCount += messages.length;
      }

      // ---- the card, recovering a hidden definition where possible ---------
      const hiddenDefinition =
        !meta.personality && (meta.token_counts?.personality_tokens ?? 0) > 0;
      let prompt = null;
      // Fetched whenever the proxy is open, not only for a hidden definition: the
      // same call is what recovers a private lorebook below.
      if (meta.allow_proxy && chats[0]) {
        prompt = await assembledPrompt(c.character_id, chats[0].chat_id);
        if (!prompt && hiddenDefinition) {
          skipped.push({
            character: c.name,
            what: "definition",
            why: "proxy call failed",
          });
        }
      } else if (hiddenDefinition) {
        skipped.push({
          character: c.name,
          what: "definition",
          why: "hidden by the creator and allow_proxy is off",
        });
      }

      // ---- lorebooks, only the ones the author left readable ---------------
      const lorebooks = [];
      const privateBooks = [];
      for (const s of meta.scripts ?? []) {
        const book = await get("/hampter/script/" + s.id);
        if (!book?.script) {
          privateBooks.push(s.title || s.id);
          continue;
        }
        let entries = [];
        try {
          entries = JSON.parse(book.script);
        } catch {
          entries = [];
        }
        if (!Array.isArray(entries) || entries.length === 0) {
          // "advanced" books are a program that builds entries at chat time, so
          // there is nothing to export before it has run.
          skipped.push({
            character: c.name,
            what: "lorebook: " + (s.title || s.id),
            why: "script-based, has no static entries",
          });
          continue;
        }
        let settings = null;
        try {
          settings = JSON.parse(book.settings || "{}");
        } catch {
          settings = null;
        }
        lorebooks.push({
          id: s.id,
          title: book.title || s.title,
          entries,
          scan_depth: settings?.depth,
        });
      }

      // One recovered book for ALL private ones on this character: the prompt does
      // not say where a book ended and the next began, so splitting per source
      // would be invented structure rather than recovered structure.
      const tail = privateBooks.length ? lorebookTail(prompt) : null;
      if (tail) {
        const entries = tail
          .split(/\n{2,}/)
          .map((para) => para.trim())
          .filter((para) => para.length > 40)
          // Keyless and constant on purpose: the keys did not survive assembly,
          // and a keyless entry that is not always-on would never fire.
          .map((content) => ({ key: [], content, constant: true, enabled: true }));
        if (entries.length > 0) {
          lorebooks.push({
            id: "recovered-" + c.character_id,
            title: "Recovered lore (" + privateBooks.join(", ") + ")",
            recovered: true,
            entries,
          });
        }
      } else if (privateBooks.length) {
        for (const title of privateBooks) {
          skipped.push({
            character: c.name,
            what: "lorebook: " + title,
            why: meta.allow_proxy
              ? "private, and the prompt carried no lore to recover"
              : "private (404) and allow_proxy is off",
          });
        }
      }

      out[c.character_id] = {
        character_id: c.character_id,
        character_name: c.name,
        card: {
          name: meta.name || c.name,
          description: meta.description || "",
          personality: meta.personality || "",
          scenario: meta.scenario || "",
          first_mes: meta.first_message || "",
          mes_example: meta.example_dialogs || "",
          creator: meta.creator_name || meta.user_name || "",
          // Every greeting, not just the one this chat opened with.
          alternate_greetings: (meta.first_messages || []).slice(1),
          tags: []
            .concat(meta.tags || [], meta.custom_tags || [])
            .map((t) => (typeof t === "string" ? t : t?.name))
            .filter(Boolean),
          avatar: c.avatar || meta.avatar || "",
          avatar_data: await avatarData(c.avatar || meta.avatar),
          // Only kept when the definition was actually HIDDEN. The prompt is
          // fetched for every proxy-enabled character because it is also where a
          // private lorebook is recovered from, but storing it when the fields
          // came through normally duplicates them, and its lore half is already
          // in the recovered lorebook.
          assembled_prompt: hiddenDefinition ? prompt : null,
        },
        lorebooks,
        chats,
      };
    }

    const payload = {
      exported_at: new Date().toISOString(),
      characters: out,
      skipped,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `janitorai-full-${new Date().toISOString().slice(0, 10)}.json`;
    // In the DOM and revoked LATE: Firefox ignores a click on a detached
    // anchor, and revoking in the same tick cancels a download it has not
    // started yet. Both end as "Done" with nothing saved.
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 60000);
    log(`If no file was saved, open this link within a minute: ${url}`);

    const books = Object.values(out).reduce((n, c) => n + c.lorebooks.length, 0);
    log(
      `Done: ${characters.length} characters, ${chatCount} messages, ${books} lorebooks.`,
    );
    if (skipped.length) {
      warn(`${skipped.length} item(s) could not be exported:`);
      console.table(skipped);
    }
  };

  // A floating button rather than a console paste: the same code, but usable by
  // someone who has never opened devtools.
  const mount = () => {
    if (document.getElementById("jai-full-export-btn")) return;
    const btn = document.createElement("button");
    btn.id = "jai-full-export-btn";
    btn.textContent = "Export all";
    btn.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "padding:10px 16px",
      "border-radius:10px",
      "border:1px solid rgba(255,255,255,.25)",
      "background:#d62896",
      "color:#fff",
      "font:600 14px system-ui,sans-serif",
      "cursor:pointer",
      "box-shadow:0 4px 14px rgba(0,0,0,.35)",
    ].join(";");
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "Exporting...";
      try {
        await runExport((done, total, name) => {
          btn.textContent = `${done}/${total} ${name}`.slice(0, 28);
        });
        btn.textContent = "Done";
      } catch (e) {
        console.error(e);
        btn.textContent = String(e?.message ?? e).slice(0, 28);
      }
      setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
      }, 4000);
    });
    document.body.appendChild(btn);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
