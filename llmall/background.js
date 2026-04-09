const PROVIDERS = {
  gemini: {
    key: "gemini",
    label: "Gemini",
    urlPatterns: ["https://gemini.google.com/*"],
    createUrl: "https://gemini.google.com/app",
    pageSettleMs: 1500,
    submitAttempts: 2,
    postInputDelayMs: 500,
    sendWaitMs: 5000,
    editorSelectors: [
      "rich-textarea textarea",
      "textarea[aria-label]",
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']"
    ],
    sendButtonSelectors: [
      "button[aria-label*='Send message']",
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[aria-label*='送信']",
      "[role='button'][aria-label*='送信']",
      "button[aria-label*='submit']",
      "button[data-test-id*='send']",
      "button[mattooltip*='Send']",
      "button[mattooltip*='送信']",
      "[role='button'][data-test-id*='send']",
      "button[type='submit']"
    ]
  },
  chatgpt: {
    key: "chatgpt",
    label: "ChatGPT",
    urlPatterns: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*"
    ],
    createUrl: "https://chatgpt.com/",
    pageSettleMs: 1500,
    submitAttempts: 2,
    postInputDelayMs: 900,
    sendWaitMs: 8000,
    editorSelectors: [
      "#prompt-textarea",
      "textarea[data-id='root']",
      "textarea[placeholder]",
      "textarea"
    ],
    sendButtonSelectors: [
      "button[data-testid='send-button']",
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[aria-label*='送信']",
      "[role='button'][aria-label*='送信']",
      "button[type='submit']"
    ]
  },
  claude: {
    key: "claude",
    label: "Claude",
    urlPatterns: ["https://claude.ai/*"],
    createUrl: "https://claude.ai/new",
    pageSettleMs: 3500,
    submitAttempts: 3,
    postInputDelayMs: 900,
    sendWaitMs: 8000,
    editorSelectors: [
      ".ProseMirror[contenteditable='true']",
      "div[data-placeholder][contenteditable='true']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'][data-testid*='input']",
      "div[contenteditable='true']",
      "textarea"
    ],
    sendButtonSelectors: [
      "button[data-testid='send-button']",
      "button[aria-label*='Send message']",
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[aria-label*='送信']",
      "[role='button'][aria-label*='送信']",
      "button[data-testid*='send']",
      "[role='button'][data-testid*='send']",
      "button[type='submit']"
    ]
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SUBMIT_PROMPT") {
    return false;
  }

  handlePromptSubmission(message.prompt, Boolean(message.openOnly))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        results: Object.values(PROVIDERS).map((provider) => ({
          provider: provider.label,
          ok: false,
          message: error instanceof Error ? error.message : "送信に失敗しました。"
        }))
      });
    });

  return true;
});

async function handlePromptSubmission(prompt, openOnly = false) {
  const providers = Object.values(PROVIDERS);
  const context = await getSubmissionContext();
  const tabs = [];

  for (const [index, provider] of providers.entries()) {
    const tab = await createFreshTab(provider, context, index);
    tabs.push({ provider, tab });
  }

  const results = await Promise.all(
    tabs.map(({ provider, tab }) => submitPromptToProvider(provider, prompt, tab, openOnly))
  );

  await revealSubmittedTabs(tabs.map(({ tab }) => tab), context);

  return {
    ok: results.some((result) => result.ok),
    results
  };
}

async function submitPromptToProvider(provider, prompt, existingTab, openOnly = false) {
  const tab = existingTab || (await createFreshTab(provider));
  let lastMessage = "送信に失敗しました。";

  for (let attempt = 1; attempt <= (provider.submitAttempts ?? 1); attempt += 1) {
    try {
      await waitForTabToSettle(tab.id, provider.pageSettleMs ?? 1500);

      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectPromptIntoPage,
        args: [provider, prompt, { openOnly }]
      });

      const [{ result }] = injectionResults;
      if (result?.ok) {
        return {
          provider: provider.label,
          ok: true,
          message: result.message || "送信しました。"
        };
      }

      lastMessage = result?.message || "送信に失敗しました。";
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "送信に失敗しました。";
    }
  }

  return {
    provider: provider.label,
    ok: false,
    message: lastMessage
  }
}

async function getSubmissionContext() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  return {
    windowId: activeTab?.windowId,
    tabIndex: typeof activeTab?.index === "number" ? activeTab.index : -1
  };
}

async function createFreshTab(provider, context = {}, offset = 0) {
  const createProperties = {
    url: provider.createUrl,
    active: false
  };

  if (typeof context.windowId === "number") {
    createProperties.windowId = context.windowId;
  }

  if (typeof context.tabIndex === "number") {
    createProperties.index = Math.max(0, context.tabIndex + 1 + offset);
  }

  const createdTab = await chrome.tabs.create(createProperties);

  if (!createdTab.id) {
    throw new Error(`${provider.label} のタブを作成できませんでした。`);
  }

  return createdTab;
}

async function revealSubmittedTabs(tabs, context) {
  const visibleTabs = tabs.filter((tab) => tab?.id);
  if (!visibleTabs.length) {
    return;
  }

  if (context.windowId) {
    await chrome.windows.update(context.windowId, { focused: true });
  }

  await chrome.tabs.update(visibleTabs[0].id, { active: true });
}

async function waitForTabToSettle(tabId, settleMs = 1500, timeoutMs = 30000) {
  const startedAt = Date.now();
  let stableSince = null;

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);

    if (tab.status === "complete") {
      if (stableSince === null) {
        stableSince = Date.now();
      }

      if (Date.now() - stableSince >= settleMs) {
        return;
      }
    } else {
      stableSince = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("タブの描画安定待ちがタイムアウトしました。");
}

function injectPromptIntoPage(provider, prompt, options = {}) {
  const openOnly = Boolean(options.openOnly);
  const timeoutAt = Date.now() + 20000;
  const sendKeywords = ["send", "submit", "送信", "メッセージを送信"];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isVisible = (element) => {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const isEnabledButton = (element) => {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      return false;
    }

    if (element.getAttribute("aria-disabled") === "true") {
      return false;
    }

    if ("disabled" in element && element.disabled) {
      return false;
    }

    return true;
  };

  const queryFirstVisible = (selectors) => {
    for (const selector of selectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(selector));
        const visibleNode = nodes.find((node) => isVisible(node));
        if (visibleNode) {
          return visibleNode;
        }
      } catch {
        // Ignore invalid selectors from upstream config.
      }
    }

    return null;
  };

  const queryVisible = (selectors) => {
    const results = [];

    for (const selector of selectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(selector)).filter((node) =>
          isVisible(node)
        );
        results.push(...nodes);
      } catch {
        // Ignore invalid selectors from upstream config.
      }
    }

    return [...new Set(results)];
  };

  const queryVisibleWithin = (root, selectors) => {
    const results = [];

    for (const selector of selectors) {
      try {
        const nodes = Array.from(root.querySelectorAll(selector)).filter((node) => isVisible(node));
        results.push(...nodes);
      } catch {
        // Ignore invalid selectors from upstream config.
      }
    }

    return [...new Set(results)];
  };

  const getNativeValueSetter = (element) => {
    if (element instanceof HTMLTextAreaElement) {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    }

    if (element instanceof HTMLInputElement) {
      return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    }

    return null;
  };

  const setInputValue = (element, value) => {
    const setter = getNativeValueSetter(element);
    if (!setter) {
      throw new Error("入力欄の値を設定できませんでした。");
    }

    element.focus();
    setter.call(element, value);
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      })
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const setContentEditableValue = (element, value) => {
    element.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);

    try {
      document.execCommand("insertText", false, value);
    } catch {
      // Fallback below.
    }

    if (element.innerText.trim() !== value.trim()) {
      element.replaceChildren();
      const lines = value.split("\n");

      for (const line of lines) {
        const paragraph = document.createElement("p");
        paragraph.textContent = line || "\u200B";
        element.appendChild(paragraph);
      }
    }

    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      })
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const pasteTextIntoEditor = (element, value) => {
    element.focus();

    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", value);

      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });

      element.dispatchEvent(pasteEvent);
    } catch {
      // Fall through to DOM-based insertion checks below.
    }

    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: value
      })
    );

    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: value
      })
    );
  };

  const getEditorText = (element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.innerText;
    }

    return "";
  };

  const normalizeText = (value) => value.replace(/\u200B/g, "").replace(/\r\n/g, "\n").trim();

  const getButtonIntentScore = (button) => {
    if (!isEnabledButton(button)) {
      return -1;
    }

    const label = [
      button.getAttribute("aria-label"),
      button.textContent,
      button.getAttribute("title")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (
      ["menu", "attachment", "voice", "microphone", "upload", "plus", "add"].some((keyword) =>
        label.includes(keyword)
      )
    ) {
      return -1;
    }

    let score = 0;

    if (sendKeywords.some((keyword) => label.includes(keyword))) {
      score += 5;
    }

    if (button.matches("[data-testid='send-button'], [data-testid*='send']")) {
      score += 6;
    }

    if (button.querySelector("svg")) {
      score += 1;
    }

    return score;
  };

  const rankButtons = (buttons) =>
    buttons
      .filter((button) => getButtonIntentScore(button) >= 0)
      .sort((left, right) => getButtonIntentScore(right) - getButtonIntentScore(left));

  const findNearestSendButton = (editor) => {
    let container = editor instanceof HTMLElement ? editor.parentElement : null;

    for (let depth = 0; depth < 10 && container; depth += 1) {
      const candidates = Array.from(
        container.querySelectorAll("button, [role='button']")
      );
      const rankedButtons = rankButtons(candidates);

      if (rankedButtons.length) {
        return rankedButtons[0];
      }

      container = container.parentElement;
    }

    return null;
  };

  const findEditorsNearConfiguredButtons = () => {
    const configuredButtons = rankButtons(queryVisible(provider.sendButtonSelectors));
    const editorCandidates = [];

    for (const button of configuredButtons) {
      let container = button.parentElement;

      for (let depth = 0; depth < 8 && container; depth += 1) {
        const nearbyEditors = queryVisibleWithin(container, provider.editorSelectors);

        for (const editor of nearbyEditors) {
          editorCandidates.push({
            editor,
            score: 20 + getButtonIntentScore(button) - depth
          });
        }

        container = container.parentElement;
      }
    }

    return editorCandidates;
  };

  const rankEditors = () => {
    const configuredEditors = queryVisible(provider.editorSelectors);
    const buttonAnchoredEditors = findEditorsNearConfiguredButtons();
    const rankedEditors = configuredEditors
        .map((editor) => {
          let score = 0;

          if (editor.matches(".ProseMirror[contenteditable='true']")) {
            score += 6;
          }

          if (editor.matches("div[data-placeholder][contenteditable='true']")) {
            score += 5;
          }

          if (editor.matches("[role='textbox']")) {
            score += 2;
          }

          const nearestSendButton = findNearestSendButton(editor);
          if (nearestSendButton) {
            score += 8 + getButtonIntentScore(nearestSendButton);
          }

          return { editor, score };
        })
        .concat(buttonAnchoredEditors)
        .sort((left, right) => right.score - left.score);

    if (rankedEditors.length) {
      const deduped = [];
      const seen = new Set();

      for (const item of rankedEditors) {
        if (seen.has(item.editor)) {
          continue;
        }

        seen.add(item.editor);
        deduped.push(item);
      }

      return deduped;
    }

    const fallbackTextarea = Array.from(document.querySelectorAll("textarea")).find((element) =>
      isVisible(element)
    );
    if (fallbackTextarea) {
      return [{ editor: fallbackTextarea, score: 1 }];
    }

    const fallbackEditable = Array.from(document.querySelectorAll("[contenteditable='true']")).find(
      (element) => isVisible(element)
    );

    return fallbackEditable ? [{ editor: fallbackEditable, score: 1 }] : [];
  };

  const findEditor = () => {
    const rankedEditors = rankEditors();
    return rankedEditors[0]?.editor || null;
  };

  const findSendButton = (editor) => {
    const configuredButton = queryFirstVisible(provider.sendButtonSelectors);
    if (provider.key !== "claude" && isEnabledButton(configuredButton)) {
      return configuredButton;
    }

    const nearbyButton = findNearestSendButton(editor);
    if (nearbyButton) {
      return nearbyButton;
    }

    if (provider.key === "claude" && isEnabledButton(configuredButton)) {
      return configuredButton;
    }

    const form = editor.closest("form");
    if (form) {
      const formButton = form.querySelector(
        "button[type='submit']:not([disabled]), [role='button'][type='submit']"
      );
      if (isEnabledButton(formButton)) {
        return formButton;
      }
    }

    const nearButtons = rankButtons(Array.from(document.querySelectorAll("button, [role='button']")));
    return nearButtons[0] || null;
  };

  const clickElement = (element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.focus();
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    element.click();
  };

  const ensureEditorContainsPrompt = async (editor, value) => {
    const normalizedPrompt = normalizeText(value);
    const currentText = normalizeText(getEditorText(editor));
    if (currentText === normalizedPrompt) {
      return true;
    }

    if (editor instanceof HTMLElement && editor.isContentEditable) {
      pasteTextIntoEditor(editor, value);
      await sleep(250);
      return normalizeText(getEditorText(editor)) === normalizedPrompt;
    }

    return false;
  };

  const pressEnterToSubmit = async (editor) => {
    const before = getEditorText(editor).trim();

    editor.focus();

    for (const eventName of ["keydown", "keypress", "keyup"]) {
      editor.dispatchEvent(
        new KeyboardEvent(eventName, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
    }

    await sleep(500);

    const after = getEditorText(editor).trim();
    return after !== before || after.length === 0;
  };

  const clickSendButton = async (editor, maxWaitMs = provider.sendWaitMs ?? 5000) => {
    const clickDeadline = Math.min(timeoutAt, Date.now() + maxWaitMs);

    while (Date.now() < clickDeadline) {
      const button = findSendButton(editor);
      if (button) {
        clickElement(button);
        return true;
      }

      await sleep(250);
    }

    return false;
  };

  const trySubmit = async () => {
    let lastFailureMessage = "入力欄が見つかりませんでした。";

    while (Date.now() < timeoutAt) {
      const rankedEditors = rankEditors();
      if (!rankedEditors.length) {
        lastFailureMessage = "入力欄の表示待ちです。";
        await sleep(350);
        continue;
      }

      for (const { editor } of rankedEditors) {
        if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
          setInputValue(editor, prompt);
        } else if (editor instanceof HTMLElement && editor.isContentEditable) {
          setContentEditableValue(editor, prompt);
        } else {
          continue;
        }

        await sleep(provider.postInputDelayMs ?? 300);

        if (!(await ensureEditorContainsPrompt(editor, prompt))) {
          lastFailureMessage = "入力欄候補は見つかりましたが、テキストを反映できませんでした。";
          continue;
        }

        if (openOnly) {
          return {
            ok: true,
            message: "新規チャットを開いて入力しました。"
          };
        }

        const didClick = await clickSendButton(editor);
        if (didClick) {
          return {
            ok: true,
            message: "新規チャットで送信しました。"
          };
        }

        const didPressEnter = await pressEnterToSubmit(editor);
        if (didPressEnter) {
          return {
            ok: true,
            message: "新規チャットで送信しました。"
          };
        }

        lastFailureMessage = "入力欄には入りましたが、送信UIの準備待ちで再試行しています。";
      }

      await sleep(500);
    }

    return {
      ok: false,
      message: `${lastFailureMessage} ログイン状態と表示中の画面を確認してください。`
    };
  };

  return trySubmit();
}
