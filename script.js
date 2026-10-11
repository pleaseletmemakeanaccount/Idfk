const prompts = [
  {
    label: "the default setting",
    answer: "Start <em>smaller.</em>",
    detail: "You do not need a five-year plan to make a ten-minute move.",
    signoff: "trust the first kind step",
    plain: "Start smaller. You do not need a five-year plan to make a ten-minute move."
  },
  {
    label: "a useful interruption",
    answer: "Send the <em>brave text.</em>",
    detail: "Clarity is kinder than drafting the same message in your notes app eleven times.",
    signoff: "say the truest version",
    plain: "Send the brave text. Clarity is kinder than drafting the same message in your notes app eleven times."
  },
  {
    label: "a note from later",
    answer: "Leave room for <em>surprise.</em>",
    detail: "Make the plan, then loosen your grip on it by exactly one notch.",
    signoff: "the plot can bend",
    plain: "Leave room for surprise. Make the plan, then loosen your grip on it by exactly one notch."
  },
  {
    label: "gentle evidence",
    answer: "Choose what gives <em>energy back.</em>",
    detail: "Not every exciting thing is nourishing. Notice what leaves you more yourself.",
    signoff: "follow the return current",
    plain: "Choose what gives energy back. Notice what leaves you more yourself."
  },
  {
    label: "permission slip",
    answer: "It can be a <em>no.</em>",
    detail: "A boundary is not a courtroom argument. Sometimes it is simply a complete sentence.",
    signoff: "decline with care",
    plain: "It can be a no. A boundary is not a courtroom argument. Sometimes it is simply a complete sentence."
  },
  {
    label: "borrowed courage",
    answer: "Go where you feel <em>curious.</em>",
    detail: "You do not need certainty before the first experiment. Curiosity is a valid compass.",
    signoff: "try the interesting door",
    plain: "Go where you feel curious. You do not need certainty before the first experiment."
  },
  {
    label: "a small revolt",
    answer: "Do the <em>annoying thing.</em>",
    detail: "The email, the form, the laundry: future you would like their evening back.",
    signoff: "free up some brain tabs",
    plain: "Do the annoying thing. Future you would like their evening back."
  },
  {
    label: "weather report",
    answer: "Wait until <em>tomorrow.</em>",
    detail: "Not every pause is procrastination. Some are just your nervous system taking a breath.",
    signoff: "rest is data too",
    plain: "Wait until tomorrow. Not every pause is procrastination. Some are just your nervous system taking a breath."
  }
];

const form = document.querySelector("#question-form");
const questionInput = document.querySelector("#question");
const charCount = document.querySelector("#char-count");
const card = document.querySelector("#reading-card");
const cardLabel = document.querySelector("#card-label");
const answer = document.querySelector("#answer");
const answerDetail = document.querySelector("#answer-detail");
const cardSignoff = document.querySelector("#card-signoff");
const roundNumber = document.querySelector("#round-number");
const historyList = document.querySelector("#history-list");
const clearHistoryButton = document.querySelector("#clear-history");
const toast = document.querySelector("#toast");
const copyButton = document.querySelector("#copy-button");
const anotherButton = document.querySelector("#another-button");
const soundButton = document.querySelector(".sound-button");
const coinForm = document.querySelector("#coin-form");
const coinOptionInputs = [...document.querySelectorAll(".coin-option")];
const tossButton = document.querySelector("#toss-button");
const decisionCoin = document.querySelector("#decision-coin");
const coinResult = document.querySelector("#coin-result");
const coinResultLine = document.querySelector("#coin-result-line");
const coinFeedback = document.querySelector("#coin-feedback");
const coinHint = document.querySelector("#coin-hint");
const coinReactionButtons = [...document.querySelectorAll(".coin-reaction")];
let currentIndex = 0;
let round = 1;
let soundEnabled = false;
let audioContext;
let toastTimer;
let history = safelyReadHistory();
let coinIsFlipping = false;
let activeCoinSide = "heads";
let activeCoinSelection = "";


function safelyReadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem("idfk-history") || "null");
    if (!Array.isArray(saved)) return [];

    return saved.flatMap((entry) => {
      if (!entry || typeof entry.question !== "string") return [];
      const savedIndex = entry.promptIndex;
      const promptIndex = Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < prompts.length
        ? savedIndex
        : prompts.findIndex((prompt) => prompt.answer === entry.answer);
      if (promptIndex < 0) return [];

      return [{
        question: entry.question.slice(0, 140),
        promptIndex,
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now()
      }];
    }).slice(0, 6);
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem("idfk-history", JSON.stringify(history));
  } catch {
    // The app still works if storage is unavailable.
  }
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function setCard(reading) {
  cardLabel.textContent = reading.label;
  answer.innerHTML = reading.answer;
  answerDetail.textContent = reading.detail;
  cardSignoff.textContent = reading.signoff;
}

function chooseReading() {
  let nextIndex = Math.floor(Math.random() * prompts.length);
  if (prompts.length > 1 && nextIndex === currentIndex) {
    nextIndex = (nextIndex + 1) % prompts.length;
  }
  currentIndex = nextIndex;
  return prompts[currentIndex];
}

function renderHistory() {
  clearHistoryButton.hidden = !history.length;
  if (!history.length) {
    historyList.innerHTML = '<li class="empty-state">Your next tiny decision can live here.</li>';
    return;
  }

  historyList.innerHTML = history.map((entry) => `
    <li class="history-item">
      <p class="history-question">${escapeHtml(entry.question)}</p>
      <p class="history-answer">${prompts[entry.promptIndex].answer}</p>
    </li>
  `).join("");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

function makeTinySound() {
  if (!soundEnabled || !window.AudioContext && !window.webkitAudioContext) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  audioContext ||= new Context();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(360, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(680, audioContext.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.04, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.17);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.18);
}

function offerReading(question, shouldScroll = false) {
  const reading = chooseReading();
  card.classList.remove("is-changing");
  void card.offsetWidth;
  card.classList.add("is-changing");

  window.setTimeout(() => {
    setCard(reading);
    card.classList.remove("is-changing");
  }, 205);

  round += 1;
  roundNumber.textContent = String(round).padStart(2, "0");
  makeTinySound();

  if (question) {
    history.unshift({
      question,
      promptIndex: currentIndex,
      createdAt: Date.now()
    });
    history = history.slice(0, 6);
    saveHistory();
    renderHistory();
  }

  if (shouldScroll) {
    document.querySelector(".reading-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

questionInput.addEventListener("input", () => {
  charCount.textContent = `${questionInput.value.length} / 140`;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) {
    questionInput.focus();
    return;
  }
  offerReading(question, true);
  questionInput.value = "";
  charCount.textContent = "0 / 140";
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    questionInput.value = button.dataset.prompt;
    charCount.textContent = `${questionInput.value.length} / 140`;
    questionInput.focus();
  });
});

anotherButton.addEventListener("click", () => offerReading(null));

copyButton.addEventListener("click", async () => {
  const reading = prompts[currentIndex];
  const text = `IDFK says: ${reading.plain}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied to your clipboard.");
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
    showToast("Copied to your clipboard.");
  }
  makeTinySound();
});

clearHistoryButton.addEventListener("click", () => {
  history = [];
  saveHistory();
  renderHistory();
  showToast("Today’s breadcrumbs are cleared.");
});

soundButton.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundButton.setAttribute("aria-pressed", String(soundEnabled));
  soundButton.querySelector("span").textContent = soundEnabled ? "sound on" : "sound off";
  if (soundEnabled) {
    makeTinySound();
    showToast("Tiny sounds are on.");
  }
});

let coinFlipTimer;

function updateCoinFormState() {
  const hasBothOptions = coinOptionInputs.every((input) => input.value.trim());
  tossButton.disabled = coinIsFlipping || !hasBothOptions;
  if (!coinIsFlipping) {
    coinHint.textContent = hasBothOptions
      ? "Both doors are named. Take a breath, then flip."
      : "Name both doors to wake the coin.";
  }
}

coinOptionInputs.forEach((input) => {
  input.addEventListener("input", () => {
    coinResult.hidden = true;
    coinResultLine.textContent = "";
    coinFeedback.textContent = "";
    coinReactionButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
    updateCoinFormState();
  });
});

coinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (coinIsFlipping) return;
  const options = coinOptionInputs.map((input) => input.value.trim());
  const firstEmptyInput = coinOptionInputs.find((input) => !input.value.trim());
  if (firstEmptyInput) {
    firstEmptyInput.focus();
    updateCoinFormState();
    return;
  }

  activeCoinSide = Math.random() < 0.5 ? "heads" : "tails";
  activeCoinSelection = options[activeCoinSide === "heads" ? 0 : 1];
  const startingAngle = decisionCoin.dataset.side === "tails" ? 180 : 0;
  const landingAngle = activeCoinSide === "tails" ? 180 : 0;
  const extraTurn = (landingAngle - startingAngle + 360) % 360;
  decisionCoin.style.setProperty("--spin-from", `${startingAngle}deg`);
  decisionCoin.style.setProperty("--spin-to", `${startingAngle + 1440 + extraTurn}deg`);

  coinIsFlipping = true;
  tossButton.disabled = true;
  tossButton.setAttribute("aria-busy", "true");
  coinResult.hidden = true;
  coinFeedback.textContent = "";
  coinReactionButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
  coinHint.textContent = "A tiny moment of suspense…";
  decisionCoin.classList.remove("is-flipping");
  void decisionCoin.offsetWidth;
  decisionCoin.classList.add("is-flipping");
  window.clearTimeout(coinFlipTimer);
  coinFlipTimer = window.setTimeout(finishCoinFlip, 1400);
});

function finishCoinFlip() {
  if (!coinIsFlipping) return;
  window.clearTimeout(coinFlipTimer);
  coinIsFlipping = false;
  decisionCoin.classList.remove("is-flipping");
  decisionCoin.dataset.side = activeCoinSide;
  const letter = activeCoinSide === "heads" ? "A" : "B";
  coinResultLine.textContent = `The coin picked ${letter}: ${activeCoinSelection}.`;
  coinResult.hidden = false;
  coinHint.textContent = "The coin has had its say. Your first reaction is the interesting part.";
  tossButton.removeAttribute("aria-busy");
  updateCoinFormState();
  makeTinySound();
}

decisionCoin.addEventListener("animationend", (event) => {
  if (event.animationName === "coin-flip") finishCoinFlip();
});

const reactionNotes = {
  relief: "That little exhale counts as information. You can follow it, or take a little more time.",
  disappointment: "Interesting. The other door may deserve a closer look — no coin required.",
  unsure: "Still unsure is allowed. Maybe you need one more piece of information, or simply a little time."
};

coinReactionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (coinResult.hidden) return;
    coinReactionButtons.forEach((reaction) => {
      reaction.setAttribute("aria-pressed", String(reaction === button));
    });
    coinFeedback.textContent = reactionNotes[button.dataset.reaction];
  });
});

renderHistory();
