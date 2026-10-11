# IDFK?

A tiny, tender decision machine for the beautifully undecided.

Ask it about the thing orbiting your brain, receive a small nudge, and keep a local trail of the decisions you were brave enough to name. IDFK is intentionally not an oracle: it is a playful mirror for finding your own next step.

## Run it

This is a dependency-free static site. From the project directory:

```bash
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

## Included

- A responsive, keyboard-friendly one-page experience
- Randomized gentle nudges with a copy-to-clipboard action
- A two-choice coin flip that turns your first reaction into a gentle gut check
- A passphrase-locked diary, encrypted in the browser and never uploaded by the app
- Prompt starters, optional tiny sounds, and motion that respects reduced-motion preferences
- A six-item localStorage history, with no accounts or backend required

The diary uses browser Web Crypto (PBKDF2 + AES-GCM) to encrypt pages before they are saved. Your passphrase is not recoverable; clearing this site’s browser storage erases the notebook.
