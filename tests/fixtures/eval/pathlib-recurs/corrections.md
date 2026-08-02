# Corrections

<!-- Appended by `handoff correct`. Newest last. -->

## 2026-01-03T09:12:00Z

**agent did:** used os.path.join to build the cache path

**user said:** always prefer pathlib over os.path

**lesson:** use pathlib.Path for filesystem paths, not os.path

---

## 2026-01-08T14:03:00Z

**agent did:** reached for os.path.exists again in the loader

**user said:** pathlib, not os.path — I keep saying this

**lesson:** pathlib everywhere for path handling, drop os.path

---

## 2026-01-15T11:20:00Z

**agent did:** wrote os.path.dirname in the new exporter

**user said:** use pathlib, no os.path anywhere in this project

**lesson:** prefer pathlib over os.path, no exceptions

---

## 2026-07-11T10:00:00Z

**agent did:** generated a README for the utils folder

**user said:** stop writing markdown docs nobody asked for

**lesson:** don't author documentation without a request

---

## 2026-07-14T16:30:00Z

**agent did:** bumped the pytest version in the middle of the task

**user said:** never change tool versions without checking first

**lesson:** pin versions and ask before upgrading anything

---

## 2026-07-18T09:45:00Z

**agent did:** added a plugin abstraction for a single call site

**user said:** simplest working solution, no speculative flexibility

**lesson:** avoid premature abstraction for one use

---
