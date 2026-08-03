# Corrections

<!-- Appended by `handoff correct`. Newest last. -->

## 2026-03-01T09:00:00Z

**agent did:** committed without running the formatter

**user said:** always run prettier before you commit

**lesson:** run prettier before every commit

---

## 2026-03-05T09:00:00Z

**agent did:** pushed unformatted code again

**user said:** run prettier before you commit, every time

**lesson:** run prettier before every commit, no exceptions

---

## 2026-03-10T09:00:00Z

**agent did:** skipped the formatter on the hotfix

**user said:** even hotfixes get prettier before you commit

**lesson:** run prettier before every commit including hotfixes

---

## 2026-03-15T09:00:00Z

**agent did:** forgot to run the formatter before pushing

**user said:** run prettier before you commit, muscle memory please

**lesson:** run prettier before every commit, always

---

## 2026-03-20T09:00:00Z

**agent did:** committed with formatting diffs outstanding

**user said:** run prettier before you commit so diffs stay clean

**lesson:** run prettier before every commit to keep diffs clean

---

## 2026-07-05T13:00:00Z

**agent did:** used tabs in a file the project indents with spaces

**user said:** match the editorconfig, spaces not tabs

**lesson:** follow editorconfig indentation settings

---

## 2026-07-10T13:00:00Z

**agent did:** named a variable `data`

**user said:** use descriptive names, not data or tmp

**lesson:** pick meaningful identifiers over placeholders

---

## 2026-07-15T13:00:00Z

**agent did:** left a stray console.log in the bundle

**user said:** remove debug logging before shipping

**lesson:** strip console.log from shipped code

---

## 2026-07-20T13:00:00Z

**agent did:** hardcoded the API base URL in the client

**user said:** the API base URL must come from an environment variable — never hardcode the staging or production host

**lesson:** read the API base URL from environment config, never inline it

---
