const form = document.querySelector("#prompt-form");
const promptField = document.querySelector("#prompt");
const submitButton = document.querySelector("#submit-button");

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "送信中..." : "送信";
}

promptField.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
    return;
  }

  event.preventDefault();

  if (!submitButton.disabled) {
    form.requestSubmit();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = promptField.value.trim();
  if (!prompt) {
    promptField.focus();
    return;
  }

  setBusy(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SUBMIT_PROMPT",
      prompt
    });

    if (!response || !Array.isArray(response.results)) {
      throw new Error("拡張から応答を取得できませんでした。");
    }

    if (response.results.some((result) => result.ok)) {
      window.close();
      return;
    }
  } catch (error) {
    console.error(error);
  } finally {
    setBusy(false);
  }
});
