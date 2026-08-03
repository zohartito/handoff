# Corrections

<!-- Appended by `handoff correct`. Newest last. -->

## 2026-04-01T09:00:00Z

**agent did:** mutated the redux state array in place in the reducer

**user said:** never mutate redux state directly, use immer or return a new object

**lesson:** reducers must not mutate state, use immer for updates

---

## 2026-04-05T09:00:00Z

**agent did:** pushed onto state.items inside the reducer again

**user said:** immer, not direct mutation — redux state is immutable

**lesson:** use immer so redux state is never mutated in place

---

## 2026-04-10T09:00:00Z

**agent did:** assigned state.total directly in the cart reducer

**user said:** use immer, do not mutate redux state fields directly

**lesson:** reducers update via immer, never mutate state directly

---

## 2026-05-01T10:00:00Z

**source:** auto

**agent did:** left an unused import in the module

**user said:** eslint flagged a no-unused-vars warning on the import

**lesson:** clear the no-unused-vars eslint warning

---

## 2026-05-02T10:00:00Z

**source:** auto

**agent did:** declared a variable that was never read

**user said:** eslint no-unused-vars warning on that variable

**lesson:** remove the unused variable flagged by eslint

---

## 2026-05-03T10:00:00Z

**source:** auto

**agent did:** imported a helper that was not used

**user said:** eslint no-unused-vars warning again

**lesson:** drop the unused import per the eslint warning

---

## 2026-05-04T10:00:00Z

**source:** auto

**agent did:** kept an unused destructured field

**user said:** eslint no-unused-vars warning on the destructure

**lesson:** delete unused destructured vars to satisfy eslint

---

## 2026-07-01T16:00:00Z

**agent did:** added a comment explaining an obvious line

**user said:** only comment genuinely subtle logic

**lesson:** skip comments on self-evident code

---
