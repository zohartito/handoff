# Corrections

<!-- Appended by `handoff correct`. Newest last. -->

## 2026-02-02T08:30:00Z

**agent did:** built a download route that joined the request filename onto the storage directory

**user said:** that is a path traversal hole — a filename like ../../etc/passwd escapes the uploads folder; confine the resolved path to the storage root and reject anything outside it

**lesson:** never resolve user-supplied filenames into a filesystem path without confining the result to an allowed base directory

---

## 2026-06-20T12:00:00Z

**agent did:** used a magic pixel value for the card gutter

**user said:** pull spacing from the design tokens, not hardcoded pixels

**lesson:** use the spacing scale tokens for layout gaps

---

## 2026-06-25T09:15:00Z

**agent did:** hardcoded another margin on the modal

**user said:** again — spacing comes from tokens

**lesson:** margins and paddings use the token scale

---

## 2026-07-01T15:40:00Z

**agent did:** renamed a shared helper without updating callers

**user said:** do the rename in one commit and update the call sites

**lesson:** keep renames atomic across the codebase

---

## 2026-07-05T10:05:00Z

**agent did:** left the button with no loading state

**user said:** async actions need a loading state

**lesson:** show a spinner while async work is in flight

---

## 2026-07-09T11:30:00Z

**agent did:** forgot the loading state on the save form

**user said:** loading state, like I said before

**lesson:** async submit buttons need a pending state

---

## 2026-07-12T14:20:00Z

**agent did:** left imports unsorted in the new file

**user said:** keep imports grouped and ordered

**lesson:** sort imports by group per the lint rule

---
